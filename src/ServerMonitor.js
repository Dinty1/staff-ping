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
        this.lastSeenData = JSON.parse(this.lastSeenDataMessage.content);

        this.checkServer();
        setInterval(() => this.checkServer(), config.check_interval);
    }

    async checkServer() {
        const { data: staffData } = await axios.get(`https://script.google.com/macros/s/AKfycbwde4vwt0l4_-qOFK_gL2KbVAdy7iag3BID8NWu2DQ1566kJlqyAS1Y/exec?spreadsheetId=${config.player_spreadsheet_id}&sheetName=${config.player_spreadsheet_sheet_name}`);
        
        const server = await mcUtil.status("minecartrapidtransit.net");

        if (!server.players.sample) return; // Not much we can do here
        const onlineIds = server.players.sample.map(p => p.id);

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

        this.updateStatusMessage(foundConductor, foundMod, foundAdmin);

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

    async updateStatusMessage(onlineConductor, onlineMod, onlineAdmin) {
        const statusChannel = this.client.channels.cache.get(config.status_channel);

        let newStatusMessage = "**Roles and their Last Seen Dates**";
        newStatusMessage += `\nConductor: ${onlineConductor ? `:green_square: (${escapeMarkdown(onlineConductor)})` : `:red_square: (${this.timestamp(this.lastSeenData.conductor)})`}`;
        newStatusMessage += `\nMod: ${onlineMod ? `:green_square: (${escapeMarkdown(onlineMod)})` : `:red_square: (${this.timestamp(this.lastSeenData.mod)})`}`;
        newStatusMessage += `\nAdmin: ${onlineAdmin ? `:green_square: (${escapeMarkdown(onlineAdmin)})` : `:red_square: (${this.timestamp(this.lastSeenData.admin)})`}`;

        const statusMessage = (await statusChannel.messages.fetch({ limit: 1 })).first();
        statusMessage.edit(newStatusMessage);
    }

    timestamp(timeMs) {
        return `<t:${Math.floor(timeMs / 1000)}:R>`;
    }
}