import { config } from "./index.js";
import axios from "axios";
import mcUtil from "minecraft-server-util";
import escapeMarkdown from "./util/escapeMarkdown.js";
import prettyMilliseconds from "pretty-ms";

export default class ServerMonitor {
    client;

    lastSeenDataMessage;
    lastSeenData;

    constructor(client) {
        this.client = client;
    }

    async run() {
        this.lastSeenDataMessage = (await this.client.channels.cache.get(config.last_seen_storage_channel).messages.fetch({ limit: 1 })).first();

        if (this.lastSeenDataMessage.content.length > 1900) this.client.channels.cache.get(config.private_stuff_channel).send("Last seen data is getting near to 2000 characters");

        this.lastSeenData = JSON.parse(this.lastSeenDataMessage.content);

        this.checkServer();
        setInterval(() => this.checkServer(), config.check_interval);
    }

    async checkServer() {
        const { data: staffData } = await axios.get(`https://script.google.com/macros/s/AKfycbwde4vwt0l4_-qOFK_gL2KbVAdy7iag3BID8NWu2DQ1566kJlqyAS1Y/exec?spreadsheetId=${config.player_spreadsheet_id}&sheetName=${config.player_spreadsheet_sheet_name}`);
        
        const server = await mcUtil.queryFull("minecartrapidtransit.net");

        if (!server.players.list) return; // Not much we can do here
        const onlineNames = server.players.list;

        const onlineIds = [];

        // Need to convert these names to IDs. Max number per request is 10
        for (let i = 0; i < onlineNames.length; i += 10) {
            let { data } = await axios.post("https://api.mojang.com/profiles/minecraft", onlineNames.slice(i, i + 10));
            onlineIds.push(...data.map(p => p.id));
        }

        const onlineStaff = [];

        for (const staffMember of staffData) {
            if (onlineIds.includes(staffMember.UUID)) {
                this.lastSeenData[staffMember.UUID] = Date.now();
                onlineStaff.push(staffMember);
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

        this.updateStatusMessage(foundConductor, foundMod, foundAdmin, onlineStaff, staffData);

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

        this.saveLastSeenData();

        if (pinging.length == 0) return; // No deadzones ended

        let outputMessage = `${pinging.map(r => "<@&" + r + ">").join(" ")} **${escapeMarkdown(onlinePerson)}** has joined! Deadzones ended:`;

        if (adminDeadzoneLength) outputMessage += `\n**Admin:** ${prettyMilliseconds(adminDeadzoneLength, {verbose: true})}`;
        if (modDeadzoneLength) outputMessage += `\n**Mod:** ${prettyMilliseconds(modDeadzoneLength, {verbose: true})}`;
        if (conductorDeadzoneLength) outputMessage += `\n**Conductor:** ${prettyMilliseconds(conductorDeadzoneLength, {verbose: true})}`;

        this.client.channels.cache.get(config.ping_channel).send(outputMessage);
    }

    async saveLastSeenData() {
        this.lastSeenDataMessage.edit(JSON.stringify(this.lastSeenData));
    }

    async updateStatusMessage(onlineConductor, onlineMod, onlineAdmin, onlineStaff, staffData) {
        const statusChannel = this.client.channels.cache.get(config.status_channel);

        let newStatusMessageBuilder = ["**Roles and their Last Seen Dates**"];
        newStatusMessageBuilder.push(`Conductor: ${onlineConductor ? `:green_square: (${escapeMarkdown(onlineConductor)})` : `:red_square: (${this.timestamp(this.lastSeenData.conductor)})`}`);
        newStatusMessageBuilder.push(`Mod: ${onlineMod ? `:green_square: (${escapeMarkdown(onlineMod)})` : `:red_square: (${this.timestamp(this.lastSeenData.mod)})`}`);
        newStatusMessageBuilder.push(`Admin: ${onlineAdmin ? `:green_square: (${escapeMarkdown(onlineAdmin)})` : `:red_square: (${this.timestamp(this.lastSeenData.admin)})`}`);

        newStatusMessageBuilder.push(`\n**Staff/Conductors and their Last Seen Dates**`);
        for (const staffMember of staffData) {
            let staffMemberMessage = `${onlineStaff.includes(staffMember) ? ":green_square:" : ":red_square:" } ${this.rankEmoji(staffMember.Rank)} ${escapeMarkdown(staffMember.Name)}${onlineStaff.includes(staffMember) ? "" : `: ${this.lastSeenData[staffMember.UUID] ? this.timestamp(this.lastSeenData[staffMember.UUID]) : ":shrug:" }`}`;

            newStatusMessageBuilder.push(staffMemberMessage);
        }

        // Because of rate limits and things we're going to spread this out over multiple messages
        // If you want to preserve your brain stop reading now
        const statusMessages = Array.from((await statusChannel.messages.fetch({ limit: 10 })).values()).reverse();
        
        let currentMessageBuffer = [];

        for (const line of newStatusMessageBuilder) {
            if (currentMessageBuffer.join("\n").length + line.length > 2000) {
                if (statusMessages[0]) {
                    statusMessages[0].edit(currentMessageBuffer.join("\n"));
                    statusMessages.shift();
                }
                else statusChannel.send(currentMessageBuffer.join("\n"));
                currentMessageBuffer = [];
            } else currentMessageBuffer.push(line);
        }

        if (currentMessageBuffer.length > 0) {
            if (statusMessages[0]) {
                statusMessages[0].edit(currentMessageBuffer.join("\n"));
                statusMessages.shift();
            }
            else statusChannel.send(currentMessageBuffer.join("\n"));
        }

        statusMessages.forEach(m => m.delete()); // Anything left over is spare and can go
    }

    timestamp(timeMs) {
        return `<t:${Math.floor(timeMs / 1000)}:R>`;
    }

    rankEmoji(rank) {
        switch (rank) {
            case "Admin": return "<:Ad:997944788747825284>";
            case "Mod": return "<:Mo:997944804518395994>";
            case "Conductor": return "<:Co:997944814295334913>";
        }
    }
}