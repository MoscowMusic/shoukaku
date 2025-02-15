import Websocket from 'ws';
import {Rest} from './Rest';
import {wait} from '../Utils';
import {EventEmitter} from 'events';
import {IncomingMessage} from 'http';
import {NodeOption, Shoukaku} from '../Shoukaku';
import {OpCodes, State, Versions} from '../Constants';

export interface NodeStats {
    players: number;
    playingPlayers: number;
    memory: {
        reservable: number;
        used: number;
        free: number;
        allocated: number
    };
    frameStats: {
        sent: number;
        deficit: number;
        nulled: number
    };
    cpu: {
        cores: number;
        systemLoad: number;
        lavalinkLoad: number;
    };
    uptime: number;
}

type NodeInfoVersion = {
    semver: string;
    major: number;
    minor: number;
    patch: number;
    preRelease?: string;
    build?: string;
};

type NodeInfoGit = {
    branch: string;
    commit: string;
    commitTime: number;
};

type NodeInfoPlugin = {
    name: string;
    version: string;
};

export type NodeInfo = {
    version: NodeInfoVersion;
    buildTime: number;
    git: NodeInfoGit;
    jvm: string;
    lavaplayer: string;
    sourceManagers: string[];
    filters: string[];
    plugins: NodeInfoPlugin[];
};

export interface ResumableHeaders {
    [key: string]: string;

    'Client-Name': string;
    'User-Agent': string;
    'Authorization': string;
    'User-Id': string;
    'Session-Id': string;
}

export interface NonResumableHeaders extends Omit<ResumableHeaders, 'Session-Id'> {
}

/**
 * Represents a Lavalink node
 */
export class Node extends EventEmitter {
    /**
     * Shoukaku class
     */
    public readonly manager: Shoukaku;
    /**
     * Lavalink rest API
     */
    public readonly rest: Rest;
    /**
     * Name of this node
     */
    public readonly name: string;
    /**
     * Group in which this node is contained
     */
    public readonly group?: string;
    /**
     * Websocket version this node will use
     */
    public readonly version: string;
    /**
     * URL of Lavalink
     */
    private readonly url: string;
    /**
     * Credentials to access Lavalink
     */
    private readonly auth: string;
    /**
     * The number of reconnects to Lavalink
     */
    public reconnects: number;
    /**
     * The state of this connection
     */
    public state: State;
    /**
     * Statistics from Lavalink
     */
    public stats: NodeStats | null;
    /**
     * Information about lavalink node
     */
    public info: NodeInfo | null;
    /**
     * Websocket instance
     */
    public ws: Websocket | null;
    /**
     * SessionId of this Lavalink connection (not to be confused with Discord SessionId)
     */
    public sessionId: string | undefined;
    /**
     * Boolean that represents if the node has initialized once
     */
    protected initialized: boolean;
    /**
     * Boolean that represents if this connection is destroyed
     */
    protected destroyed: boolean;

    /**
     * @param manager Shoukaku instance
     * @param options Options on creating this node
     * @param options.name Name of this node
     * @param options.url URL of Lavalink
     * @param options.auth Credentials to access Lavalink
     * @param options.secure Whether to use secure protocols or not
     * @param options.group Group of this node
     */
    constructor(manager: Shoukaku, options: NodeOption) {
        super();
        this.manager = manager;
        this.rest = new (this.manager.options.structures.rest || Rest)(this, options);
        this.name = options.name;
        this.group = options.group;
        this.version = `/v${Versions.WEBSOCKET_VERSION}`;
        this.url = `${options.secure ? 'wss' : 'ws'}://${options.url}`;
        this.auth = options.auth;
        this.reconnects = 0;
        this.state = State.DISCONNECTED;
        this.stats = null;
        this.info = null;
        this.ws = null;
        this.initialized = false;
        this.destroyed = false;
    };

    /**
     * Penalties for load balancing
     * @returns Penalty score
     * @internal @readonly
     */
    get penalties(): number {
        let penalties = 0;
        if (!this.stats) return penalties;

        penalties += this.stats.players;
        penalties += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10);

        if (this.stats.frameStats) {
            penalties += this.stats.frameStats.deficit;
            penalties += this.stats.frameStats.nulled * 2;
        }

        return penalties;
    };

    /**
     * If we should clean this node
     * @internal @readonly
     */
    private get shouldClean(): boolean {
        return this.destroyed || this.reconnects + 1 >= this.manager.options.reconnectTries
    };

    /**
     * Connect to Lavalink
     */
    public connect(): void {
        if (!this.manager.id) throw new Error('Don\'t connect a node when the library is not yet ready');
        if (this.destroyed) throw new Error('You can\'t re-use the same instance of a node once disconnected, please re-add the node again');

        this.state = State.CONNECTING;

        const headers: NonResumableHeaders | ResumableHeaders = {
            'Client-Name': this.manager.options.userAgent,
            'User-Agent': this.manager.options.userAgent,
            'Authorization': this.auth,
            'User-Id': this.manager.id
        };

        const session = [...this.manager.dumps].find(dump => dump.node.name === this.name)?.node.sessionId;
        if (this.manager.options.resume && session) headers['Session-Id'] = session;

        this.emit('debug', `[Socket] -> [${this.name}] : Connecting ${this.url}, Version: ${this.version}, Trying to resume? ${this.manager.options.resume}`);
        if (!this.initialized) this.initialized = true;

        const url = new URL(`${this.url}${this.version}/websocket`);
        this.ws = new Websocket(url.toString(), {headers} as Websocket.ClientOptions);
        this.ws.once('upgrade', response => this.open(response));
        this.ws.once('close', (...args) => this.close(...args));
        this.ws.on('error', error => this.error(error));
        this.ws.on('message', data => this.message(data).catch(error => this.error(error)));
    };

    /**
     * Disconnect from lavalink
     * @param code Status code
     * @param reason Reason for disconnect
     */
    public disconnect(code: number, reason?: string): void {
        if (this.destroyed) return;

        this.destroyed = true;
        this.state = State.DISCONNECTING;

        if (this.ws)
            this.ws.close(code, reason);
        else
            this.clean();
    };

    /**
     * Handle connection open event from Lavalink
     * @param response Response from Lavalink
     * @internal
     */
    private open(response: IncomingMessage): void {
        const resumed = response.headers['session-resumed'] === 'true';
        this.emit('debug', `[Socket] <-> [${this.name}] : Connection Handshake Done! ${this.url} | Upgrade Headers Resumed: ${resumed}`);
        this.reconnects = 0;
        this.state = State.NEARLY;
    };

    /**
     * Handle message from Lavalink
     * @param message JSON message
     * @internal
     */
    private async message(message: unknown): Promise<void> {
        if (this.destroyed) return;
        const json = JSON.parse(message as string);
        if (!json) return;
        this.emit('raw', json);
        switch (json.op) {
            case OpCodes.STATS:
                this.emit('debug', `[Socket] <- [${this.name}] : Node Status Update | Server Load: ${this.penalties}`);
                this.stats = json;
                break;
            case OpCodes.READY:
                this.sessionId = json.sessionId;

                this.state = State.CONNECTED;
                this.emit('debug', `[Socket] -> [${this.name}] : Lavalink is ready! | Lavalink resume: ${json["resumed"]}`);

                if (this.manager.options.resume) {
                    await this.rest.updateSession(this.manager.options.resume, this.manager.options.resumeTimeout);
                    this.emit('debug', `[Socket] -> [${this.name}] : Resuming configured!`);

                    await this.restorePlayers();
                }

                this.emit('ready', this.manager.dumps.filter(player => player.node.name === this.name && player.options.restored)?.length ?? 0);

                break;
            case OpCodes.EVENT:
            case OpCodes.PLAYER_UPDATE:
                const player = this.manager.players.get(json.guildId);
                if (!player) return;
                if (json.op === OpCodes.EVENT)
                    player.onPlayerEvent(json);
                else
                    player.onPlayerUpdate(json);
                break;
            default:
                this.emit('debug', `[Player] -> [Node] : Unknown Message OP ${json.op}`);
        }
    };

    /**
     * Handle closed event from lavalink
     * @param code Status close
     * @param reason Reason for connection close
     */
    private close(code: number, reason: unknown): void {
        this.emit('debug', `[Socket] <-/-> [${this.name}] : Connection Closed, Code: ${code || 'Unknown Code'}`);
        this.emit('close', code, reason);

        if (this.shouldClean) {
            // this.manager.restorePlayers(this);
            this.clean();
        } else this.reconnect();
    };

    /**
     * To emit error events easily
     * @param error error message
     */
    public error(error: Error | unknown): void {
        this.emit('error', error);
    };

    /**
     * Destroys the websocket connection
     * @internal
     */
    private destroy(count: number = 0): void {
        this.ws?.removeAllListeners();
        this.ws?.close();
        this.ws = null;
        this.state = State.DISCONNECTED;
        if (!this.shouldClean) return;
        this.destroyed = true;
        this.emit('disconnect', count);
    }

    /**
     * Cleans and moves players to other nodes if possible
     * @internal
     */
    private async clean(): Promise<void> {
        // TODO: understand what to do with this shit
        // this.manager.connectingNodes.splice(this.manager.connectingNodes.indexOf(this.manager.connectingNodes.find(e => e.name === this.name)!), 1);

        const move = this.manager.options.moveOnDisconnect;
        if (!move) return this.destroy();
        let count = 0;
        try {
            count = await this.movePlayers();
        } catch (error) {
            this.error(error);
        } finally {
            this.destroy(count);
        }
    }

    /**
     * Reconnect to Lavalink
     * @internal
     */
    private async reconnect(): Promise<void> {
        if (this.state === State.RECONNECTING) return;
        if (this.state !== State.DISCONNECTED) this.destroy();
        this.state = State.RECONNECTING;
        this.reconnects++;
        this.emit('reconnecting', this.manager.options.reconnectTries - this.reconnects, this.manager.options.reconnectInterval);
        this.emit('debug', `[Socket] -> [${this.name}] : Reconnecting in ${this.manager.options.reconnectInterval} seconds. ${this.manager.options.reconnectTries - this.reconnects} tries left`);
        await wait(this.manager.options.reconnectInterval * 1000);
        this.connect();
    }

    /**
     * Tries to restore players from the dump
     * @internal
     */
    private async restorePlayers(): Promise<void> {
        this.emit('debug', `[Socket] -> [${this.name}] : Trying to re-create players from the last session`);
        if (this.manager.dumps.length === 0) this.emit('debug', `[Socket] <- [${this.name}] : Restore canceled due to missing data`);

        for (const dump of this.manager.dumps) {
            try {
                const node = [...this.manager.nodes.values()].find(node => dump.node.name === node.name || dump.node.group === node.group);

                if (node && node.name !== this.name) continue;
                if (dump.options.timestamp + this.manager.options.resumeTimeout * 1000 < Date.now() || !node) throw "Can't restore";

                const player = await this.manager.joinVoiceChannel({
                    guildId: dump.options.guildId,
                    shardId: dump.options.shardId,
                    channelId: dump.options.channelId,
                    node: node
                });

                // use voice data from created player, old state will not work.
                dump.player.playerOptions.voice = player.data.playerOptions.voice;

                // current time calculation (approximate, the real value depends on playerUpdateInterval, which we can't get from /info endpoint).
                if (!dump.player.playerOptions.paused) dump.player.playerOptions.position = (dump.player.playerOptions.position ?? 0) + (Date.now() - dump.options.timestamp);

                await player.update(dump.player);

                this.emit('debug', `[Socket] <- [${this.name}/player/${dump.options.guildId}] : Successfully restored session`);

                this.emit('raw', {op: OpCodes.PLAYER_RESTORE, dump: dump});
                this.emit('restore', {op: OpCodes.PLAYER_RESTORE, dump: dump});

                dump.options.restored = true;
            } catch (error) {
                this.emit('debug', `[Socket] <- [${this.name}/players/${dump.options.guildId}] : Couldn't restore player because session is expired or there are no suitable nodes available`);

                this.emit('raw', {op: OpCodes.PLAYER_RESTORE, dump: dump});
                this.emit('restore', {op: OpCodes.PLAYER_RESTORE, dump: dump});
            }
        }

        this.emit('debug', `[Socket] <-> [${this.name}]: Session restore completed`);
    }

    /**
     * Tries to move the players to another node
     * @internal
     */
    private async movePlayers(): Promise<number> {
        const players = [...this.manager.players.values()];
        const data = await Promise.allSettled(players.map(player => player.move()));
        return data.filter(results => results.status === 'fulfilled').length;
    };
}
