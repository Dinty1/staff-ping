import { config } from "./index.js";
import axios from "axios";
import mcUtil from "minecraft-server-util";
import escapeMarkdown from "./util/escapeMarkdown.js";
import prettyMilliseconds from "pretty-ms";
import * as logger from "./util/log.js";

export default class ServerMonitor {
    client;

    emojis;

    lastSeenDataMessage;
    lastSeenData;

    onlineSinceDataMessage;
    onlineSinceData;

    statusErrorMessage = null;
    statusErrorSince = 0;

    constructor(client, playerEmojiManager) {
        this.client = client;
        this.playerEmojiManager = playerEmojiManager;
    }

    async run() {
        this.lastSeenDataMessage = (await this.client.channels.cache.get(config.last_seen_storage_channel).messages.fetch({ limit: 1 })).first();
        this.onlineSinceDataMessage = (await this.client.channels.cache.get(config.online_since_storage_channel).messages.fetch({ limit: 1 })).first();

        this.lastSeenData = JSON.parse(this.lastSeenDataMessage.content);
        this.onlineSinceData = JSON.parse(this.onlineSinceDataMessage.content);

        this.checkServer();
        setInterval(() => this.checkServer(), config.check_interval);
    }

    async checkServer() {
        try {
            const { data: staffData } = await axios.get(`https://script.google.com/macros/s/AKfycbwde4vwt0l4_-qOFK_gL2KbVAdy7iag3BID8NWu2DQ1566kJlqyAS1Y/exec?spreadsheetId=${config.player_spreadsheet_id}&sheetName=${config.player_spreadsheet_sheet_name}`);

            await this.playerEmojiManager.updateEmojis(false);

            this.emojis = await this.client.guilds.cache.get(config.guild).emojis.fetch();

            if (JSON.stringify(this.lastSeenData).length > 1900) {
                let purged = [];
                for (const entry of Object.keys(this.lastSeenData)) {
                    if (["conductor", "mod", "admin"].includes(entry)) continue;
                    if (staffData.map(s => s.UUID).includes(entry)) continue;

                    purged.push(entry);
                    delete this.lastSeenData[entry];
                }

                this.client.channels.cache.get(config.private_stuff_channel).send("Last seen data getting near to 2000 characters. Purged the following redundant entries: " + purged);
            }

            // In an ideal world we'd be able to just mcUtil.queryFull() and get everyone who's supposed to be visible
            // But due to some sort of stupid shite only mcUtil.status() seems to exclude vanished players
            // And mcUtil.status() only returns up to 12 players
            // So we need to get our info off dynmap and then run mcUtil.status() to see if we can pick up any stragglers who might be hidden on dynmap
            // Not 100% reliable but probably the best we can do
            // Fuck you Mojang <3
            let dynmapData;
            let server;
            dynmapData = (await axios.get("https://dynmap.minecartrapidtransit.net/standalone/dynmap_new.json")
                .catch(error => { throw error }))
                .data;
            server = await mcUtil.status("minecartrapidtransit.net", 25565, { timeout: 10000 })
                .catch(error => { throw error });


            // This might or might not be necessary idk
            if (!server || !server.players || !dynmapData || !dynmapData.players) {
                throw new Error("Unable to fetch players on the server");
            }

            if (!server.players.sample) server.players.sample = [];

            const onlineNames = dynmapData.players.map(p => p.account);
            onlineNames.push(...server.players.sample.map(p => p.name).filter(p => !onlineNames.includes(p)));

            const onlineIds = [];

            // Need to convert these names to IDs. Max number per request is 10
            for (let i = 0; i < onlineNames.length; i += 10) {
                let { data } = await axios.post("https://api.mojang.com/profiles/minecraft", onlineNames.slice(i, i + 10))
                    .catch(error => { throw new Error("Unable to reach Mojang API") });
                if (data) onlineIds.push(...data.map(p => p.id));
            }

            const onlineStaff = [];

            for (const staffMember of staffData) {
                if (onlineIds.includes(staffMember.UUID)) {
                    this.lastSeenData[staffMember.UUID] = Date.now();
                    onlineStaff.push(staffMember);

                    if (!this.onlineSinceData[staffMember.UUID]) this.onlineSinceData[staffMember.UUID] = Date.now();
                } else if (this.onlineSinceData[staffMember.UUID]) { // Not online anymore
                    delete this.onlineSinceData[staffMember.UUID];
                }
            }

            let foundConductor = null;
            let foundMod = null;
            let foundAdmin = null;
            let onlinePerson = null;

            for (const conductor of staffData.filter(v => v.Rank == "Conductor")) {
                if (onlineIds.includes(conductor.UUID)) {
                    foundConductor = onlinePerson = conductor.Name;
                    break;
                }
            }
            for (const mod of staffData.filter(v => v.Rank == "Mod")) {
                if (onlineIds.includes(mod.UUID)) {
                    foundMod = foundConductor = onlinePerson = mod.Name;
                    break;
                }
            }
            for (const admin of staffData.filter(v => v.Rank == "Admin")) {
                if (onlineIds.includes(admin.UUID)) {
                    foundAdmin = foundMod = foundConductor = onlinePerson = admin.Name;
                    break;
                }
            }

            this.updateStatusMessage(onlineStaff, staffData);

            this.saveData();
            this.statusErrorSince = 0;

            if (!onlinePerson) return; // No people so no need to do stuff

            const pinging = [];
            const conductorDeadzoneTime = parseInt(config.conductor_deadzone_time);
            const modDeadzoneTime = parseInt(config.mod_deadzone_time);
            const adminDeadzoneTime = parseInt(config.admin_deadzone_time);

            let adminDeadzoneLength
            let modDeadzoneLength;
            let conductorDeadzoneLength;

            if (foundAdmin) {
                if (Date.now() > parseInt(parseInt(this.lastSeenData.admin) + adminDeadzoneTime)) {
                    pinging.push(config.admin_ping_role);
                    adminDeadzoneLength = Date.now() - parseInt(this.lastSeenData.admin);
                }
                this.lastSeenData.admin = Date.now();
            }
            if (foundMod) {
                if (Date.now() > parseInt(this.lastSeenData.mod) + modDeadzoneTime) {
                    pinging.push(config.mod_ping_role);
                    modDeadzoneLength = Date.now() - parseInt(this.lastSeenData.mod);
                }
                this.lastSeenData.mod = Date.now();
            }
            if (foundConductor) {
                if (Date.now() > parseInt(this.lastSeenData.conductor) + conductorDeadzoneTime) {
                    pinging.push(config.conductor_ping_role);
                    conductorDeadzoneLength = Date.now() - parseInt(this.lastSeenData.conductor);
                }
                this.lastSeenData.conductor = Date.now();
            }

            if (pinging.length == 0) return; // No deadzones ended

            let outputMessage = `${pinging.map(r => "<@&" + r + ">").join(" ")} ${this.playerEmoji(onlinePerson)} **${escapeMarkdown(onlinePerson)}** has joined! Deadzones ended:`;

            if (adminDeadzoneLength) outputMessage += `\n**Admin:** ${prettyMilliseconds(adminDeadzoneLength, { verbose: true })}`;
            if (modDeadzoneLength) outputMessage += `\n**Mod:** ${prettyMilliseconds(modDeadzoneLength, { verbose: true })}`;
            if (conductorDeadzoneLength) outputMessage += `\n**Conductor:** ${prettyMilliseconds(conductorDeadzoneLength, { verbose: true })}`;

            this.client.channels.cache.get(config.ping_channel).send(outputMessage);
        } catch (error) {
            this.statusErrorMessage = error;
            if (this.statusErrorSince == 0) this.statusErrorSince = Date.now();
            logger.error("Error doing status check: " + error);
            if (error.stack) logger.error(error.stack);
            this.updateStatusMessage();
        }
    }

    async saveData() {
        this.lastSeenDataMessage.edit(JSON.stringify(this.lastSeenData));
        this.onlineSinceDataMessage.edit(JSON.stringify(this.onlineSinceData));
    }

    async updateStatusMessage(onlineStaff, staffData) {
        const statusChannel = this.client.channels.cache.get(config.status_channel);

        let newStatusMessageBuilder = [];
        let error = false;

        if (this.statusErrorMessage != null) {
            newStatusMessageBuilder.push(`:warning: **${this.statusErrorMessage}** :warning:`);
            newStatusMessageBuilder.push(`:warning: **This issue has been ongoing since ${this.timestamp(this.statusErrorSince)}** :warning:\n`);
            this.statusErrorMessage = null;
            error = true;
        } else {
            let onlineAdmins = [];
            let onlineMods = [];
            let onlineConductors = [];


            for (const staffMember of staffData) {
                if (!onlineStaff.includes(staffMember)) continue;
                switch (staffMember.Rank) {
                    case "Admin":
                        onlineAdmins.push(this.playerEmoji(staffMember.Name))
                    case "Mod":
                        onlineMods.push(this.playerEmoji(staffMember.Name))
                    case "Conductor":
                        onlineConductors.push(this.playerEmoji(staffMember.Name))
                }
            }

            newStatusMessageBuilder.push("**Roles and their Last Seen Dates**");
            newStatusMessageBuilder.push(`${onlineAdmins.length > 0 ? ":green_square:" : ":red_square:"} ${this.rankEmoji("Admin")} Admin: ${onlineAdmins.length > 0 ? `${onlineAdmins.join(" ")}` : `${this.timestamp(this.lastSeenData.admin)}`}`);
            newStatusMessageBuilder.push(`${onlineMods.length > 0 ? ":green_square:" : ":red_square:"} ${this.rankEmoji("Mod")} Mod: ${onlineMods.length > 0 ? `${onlineMods.join(" ")}` : `${this.timestamp(this.lastSeenData.mod)}`}`);
            newStatusMessageBuilder.push(`${onlineConductors.length > 0 ? ":green_square:" : ":red_square:"} ${this.rankEmoji("Conductor")} Conductor: ${onlineConductors.length > 0 ? `${onlineConductors.join(" ")}` : `${this.timestamp(this.lastSeenData.conductor)}`}`);

            newStatusMessageBuilder.push(`\n**Staff/Conductors and their Last Seen Dates**`);
            for (const staffMember of staffData) {
                let staffMemberMessage = `${onlineStaff.includes(staffMember) ? ":green_square:" : ":red_square:"} ${this.rankEmoji(staffMember.Rank)} ${this.playerEmoji(staffMember.Name)} ${escapeMarkdown(staffMember.Name)}${onlineStaff.includes(staffMember) ? ": joined " + this.timestamp(this.onlineSinceData[staffMember.UUID]) : `: ${this.lastSeenData[staffMember.UUID] ? this.timestamp(this.lastSeenData[staffMember.UUID]) : ":shrug:"}`}`;

                newStatusMessageBuilder.push(staffMemberMessage);
            }
        }

        newStatusMessageBuilder.push(`\nNext update ${this.timestamp(Date.now() + parseInt(config.check_interval))}`);

        // Because of rate limits and things we're going to spread this out over multiple messages
        // If you want to preserve your brain stop reading now
        const statusMessages = Array.from((await statusChannel.messages.fetch({ limit: 10 })).values()).reverse();

        let currentMessageBuffer = [];

        for (const line of newStatusMessageBuilder) {
            if (currentMessageBuffer.join("\n").length + line.length >= 2000) {
                if (statusMessages[0]) {
                    statusMessages[0].edit(currentMessageBuffer.join("\n"));
                    statusMessages.shift();
                }
                else statusChannel.send(currentMessageBuffer.join("\n"));
                currentMessageBuffer = [];
            }
            currentMessageBuffer.push(line);
        }

        if (currentMessageBuffer.length > 0) {
            if (statusMessages[0]) {
                statusMessages[0].edit(currentMessageBuffer.join("\n"));
                statusMessages.shift();
            }
            else statusChannel.send(currentMessageBuffer.join("\n"));
        }

        if (!error) statusMessages.forEach(m => m.edit("​")); // Anything left over is spare, but only check if there isn't an error
        else statusMessages.forEach(m => m.edit(":warning:")); // Do this if there is an error
    }

    timestamp(timeMs) {
        return `<t:${Math.floor(timeMs / 1000)}:R>`;
    }

    rankEmoji(rank) {
        switch (rank) {
            case "Admin": return "<:Admin:997944788747825284>";
            case "Mod": return "<:Mod:997944804518395994>";
            case "Conductor": return "<:Conductor:997944814295334913>";
        }
    }

    playerEmoji(player) {
        return this.emojis.find(e => e.name == player);
    }
}
