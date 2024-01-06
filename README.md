# Shoukaku

## A stable and updated wrapper around Lavalink
> This is a modified version used in our application infrastructure.<br/><br/>Shoukaku: https://github.com/shipgirlproject/Shoukaku<br/>

<br/>

### What's the difference?
> We added the "player.info" interface, which wasn't included in Shoukaku, and implemented session recovery from a dump stored in Redis or a Database.<br/>
<hr/>

Please, make sure that only the added changes and examples of their usage will be shown, so it's recommended to familiarize yourself with the [original repository](https://github.com/Deivu/Shoukaku) before starting to read.

<br/>

### Track Interface:
```TS
export interface Track {
    encoded: string;
    info: TrackInfo;
};

export interface TrackInfo {
    identifier: string;
    isSeekable: boolean;
    author: string;
    duration: number;
    isStream: boolean;
    position: number;
    title: string;
    uri?: string;
    sourceName?: string;
    artworkUrl?: string;
    isTrackUnavailable?: string;
    isrc?: string;
};
```
> Note that "isTrackUnavailable" won't be accessible, as it's used in our [Lavalink](https://github.com/MoscowMusic/lavalink-fork/releases) fork to check if the track is regionally restricted or a preview.

<br/>

So, now information will be available by calling:
```TS
shoukaku.players.get("id").track.info
```

<br/><br/>

### Session Restore:
> You should listen to the "raw" event from Shoukaku and redirect it to your functions, as regular "player.on" will stop working after a restart and will need to be reassigned manually.

```TS
shoukaku.on("raw", (name: string, json: any) => {
    // Forward to your functions like that
    this.listeners[(json.op.type || json.op) as keyof PlayerListeners]?.(name, json)
});
```
> "this.listeners" —  the "PlayerListeners" assigned through the constructor. An example class is provided below.

```TS
export class PlayerListeners {
    // constructor() {};

    // The function name should match "json.op.type" or "json.op" such as "TrackStartEvent"
    TrackStartEvent(name: string, data: TrackStartEvent) {
        // Do whatever you want
    };
};
```

<br/>
Following the example above, we listen to the "raw" event "playerUpdate" and store the data in a Database.

```TS
import { PlayerUpdate } from "@moscowcity/shoukaku";

export class PlayerListeners {
    // constructor() {};

    playerUpdate(name: string, data: PlayerUpdate) {
        // Updating data for the received guild
        this.database.updateData("queue", { guild: data.guildId }, 
            { session: this.shoukaku.playersDump.get(data.guildId) }
        );
    };
};
```
> Upon restart, we retrieve the data from the model and give it to Shoukaku.

```TS
// queue.session is a PlayerDump that we previously saved using this.shoukaku.playersDump.get(data.guildId).
const queue = (await this.app.database.getAllData("queue", undefined, false)).filter((queue: any) => queue.session);

// you need to modify this part of the code, since I'm updating each player separetely from playerUpdate event and need to create an array of all sessions.
const sessions = queue.map((queue: IQueue) => queue.session); // we need to get Array<PlayerDump> — u can save an array of all sessions using shoukaku.playersDump
   
// setup Shoukaku as usual, add the resume parameter and pass sessions.
this.shoukaku = new Shoukaku(new Connectors.Eris(this.app.client), this.app.config.values.music.nodes, {
    moveOnDisconnect: true,
    resume: true
}, PreviousSessions);
```
<br/>

© [MoscowMusic Discord Bot](https://moscowmusic.su)
