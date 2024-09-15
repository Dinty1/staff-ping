import { config } from "./index.js";
import axios from "axios";
import mcUtil from "minecraft-server-util";
import escapeMarkdown from "./util/escapeMarkdown.js";
import rankEmoji from "./util/rankEmoji.js";
import prettyMilliseconds from "pretty-ms";
import * as logger from "./util/log.js";
import DataChannel from "./DataChannel.js";
import findUUIDs from "./util/findUUIDs.js";

export default class ServerMonitor {
    client;

    emojis;

    lastSeenDataChannel;
    onlineSinceDataChannel;
    otherDataChannel;

    statusErrorMessage = null;
    statusErrorSince = 0;

    individualNotificationsManager;

    deadzoneMinLengths = {}

    constructor(client, playerEmojiManager, individualNotificationsManager) {
        this.client = client;
        this.playerEmojiManager = playerEmojiManager;
        this.individualNotificationsManager = individualNotificationsManager;
    }

    async run() {
        this.lastSeenDataChannel = new DataChannel(config.last_seen_storage_channel, this.client);
        this.onlineSinceDataChannel = new DataChannel(config.online_since_storage_channel, this.client);
        this.otherDataChannel = new DataChannel(config.other_data_storage_channel, this.client);

        this.deadzoneMinLengths.conductor = parseInt(config.deadzone_times.conductor);
        this.deadzoneMinLengths.mod = parseInt(config.deadzone_times.mod);
        this.deadzoneMinLengths.admin = parseInt(config.deadzone_times.admin);

        try { // Principal aim here is to avoid a restart loop so only checking the first thing should be fine
            this.checkServer();
        } catch (e) {
            console.error(e.stack);
        }
        setInterval(() => this.checkServer(), config.check_interval);
    }

    async getData(channel) {
        return new Promise(async (res) => {
            const messages = await this.client.channels.cache.get(channel).messages.fetch({ limit: 1 });
            if (messages.size == 0) { // This might cause issues later idk
                await this.client.channels.cache.get(channel).send("{}");
                return res({});
            }
            res(JSON.parse(messages.first().content));
        })
    }

    getSpreadsheet(id, sheet) {
        console.log("getting spreadsheet...")
        return axios.get(`https://script.google.com/macros/s/AKfycbwde4vwt0l4_-qOFK_gL2KbVAdy7iag3BID8NWu2DQ1566kJlqyAS1Y/exec?spreadsheetId=${id}&sheetName=${sheet}`)
    }

    async checkServer() {
        try {
            const { data: staffData } = await this.getSpreadsheet(config.player_spreadsheet_id, config.player_spreadsheet_sheet_name);

            if (!this.otherDataChannel.data.lastRankNag || this.otherDataChannel.data.lastRankNag + config.rank_check_interval < Date.now()) {
                const { data: members } = await this.getSpreadsheet(config.member_list_spreadsheet, config.member_list_rank_sheet);
                let rankCounts = {
                    conductor: 0,
                    mod: 0,
                    admin: 0
                }

                for (const member of members) {
                    switch (member.Rank) {
                        case "Conductor":
                            rankCounts.conductor++;
                            break;
                        case "Moderator":
                            rankCounts.mod++;
                            break;
                        case "Owner":
                        case "Administrator":
                            rankCounts.admin++;
                    }
                }

                let currentlyConfiguredRankCounts = {
                    conductor: 0,
                    mod: 0,
                    admin: 0
                }

                for (const member of staffData) {
                    switch (member.Rank) {
                        case "Conductor":
                            currentlyConfiguredRankCounts.conductor++;
                            break;
                        case "Mod":
                            currentlyConfiguredRankCounts.mod++;
                            break;
                        case "Admin":
                            currentlyConfiguredRankCounts.admin++;
                    }
                }

                if (Object.values(rankCounts).includes(0) || Object.values(currentlyConfiguredRankCounts).includes(0)) logger.error("Spreadsheet prob didn't fetch correctly");
                else if (JSON.stringify(rankCounts) != JSON.stringify(currentlyConfiguredRankCounts)) {
                    this.client.channels.cache.get(config.data_maintainers_channel).send(`Discrepancies between configured ranks and member list:\nOn config: ${JSON.stringify(currentlyConfiguredRankCounts)}\nOn member list: ${JSON.stringify(rankCounts)}`);
                    this.otherDataChannel.data.lastRankNag = Date.now();
                }
            }

            let refreshCurrent = false;
            if (!this.otherDataChannel.data.lastFullEmojiRefresh || this.otherDataChannel.data.lastFullEmojiRefresh + config.player_emojis_update_interval < Date.now()) {
                refreshCurrent = true;
                this.otherDataChannel.data.lastFullEmojiRefresh = Date.now();
                await this.saveData();
            }
            await this.playerEmojiManager.updateEmojis(refreshCurrent).catch(err => console.error(err.stack));
            if (refreshCurrent) return; // No point in continuing since it'll have been a while

            this.emojis = await this.client.guilds.cache.get(config.guild).emojis.fetch();

            if (JSON.stringify(this.lastSeenDataChannel.data).length > 1900) {
                let purged = [];
                for (const entry of Object.keys(this.lastSeenDataChannel.data)) {
                    if (["conductor", "mod", "admin"].includes(entry)) continue;
                    if (staffData.map(s => s.UUID).includes(entry)) continue;

                    purged.push(entry);
                    delete this.lastSeenDataChannel.data[entry];
                }

                if (purged.length > 0) this.client.channels.cache.get(config.private_stuff_channel).send("Last seen data getting near to 2000 characters. Purged the following redundant entries: " + purged);
            }

            // In an ideal world we'd be able to just mcUtil.queryFull() and get everyone who's supposed to be visible
            // But due to some sort of stupid shite only mcUtil.status() seems to exclude vanished players
            // And mcUtil.status() only returns up to 12 players
            // So we need to get our info off dynmap and then run mcUtil.status() to see if we can pick up any stragglers who might be hidden on dynmap
            // Not 100% reliable but probably the best we can do
            // Fuck you Mojang <3
            let dynmapData;
            let server;
            dynmapData = (await axios.get("https://dynmap.minecartrapidtransit.net/main/standalone/dynmap_new.json")
                .catch(error => { throw error }))
                .data;
            console.log("got dynmap data")
            server = await mcUtil.status("minecartrapidtransit.net", 25565, { timeout: 10000 })
                .catch(error => { throw error });
            console.log("got server status")

            // This might or might not be necessary idk
            if (!server || !server.players || !dynmapData || !dynmapData.players) {
                throw new Error("Unable to fetch players on the server");
            }

            if (!server.players.sample) server.players.sample = [];

            const onlineNames = dynmapData.players.map(p => p.account);
            onlineNames.push(...server.players.sample.map(p => p.name).filter(p => !onlineNames.includes(p)));

            const onlineIds = await findUUIDs(onlineNames);

            this.individualNotificationsManager.reportServerPlayers(onlineIds, onlineNames);

            const onlineStaff = [];

            for (const staffMember of staffData) {
                if (onlineIds.includes(staffMember.UUID)) {
                    this.lastSeenDataChannel.data[staffMember.UUID] = Date.now();
                    onlineStaff.push(staffMember);

                    if (!this.onlineSinceDataChannel.data[staffMember.UUID]) this.onlineSinceDataChannel.data[staffMember.UUID] = Date.now();
                } else if (this.onlineSinceDataChannel.data[staffMember.UUID]) { // Not online anymore
                    delete this.onlineSinceDataChannel.data[staffMember.UUID];
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

            await this.saveData();
            this.statusErrorSince = 0;

            if (!onlinePerson) return; // No people so no need to do stuff

            const pinging = [];

            let adminDeadzoneLength
            let modDeadzoneLength;
            let conductorDeadzoneLength;

            if (foundAdmin) {
                if (Date.now() > parseInt(parseInt(this.lastSeenDataChannel.data.admin) + this.deadzoneMinLengths.admin)) {
                    pinging.push(config.admin_ping_role);
                    adminDeadzoneLength = Date.now() - parseInt(this.lastSeenDataChannel.data.admin);
                }
                this.lastSeenDataChannel.data.admin = Date.now();
            }
            if (foundMod) {
                if (Date.now() > parseInt(this.lastSeenDataChannel.data.mod) + this.deadzoneMinLengths.mod) {
                    pinging.push(config.mod_ping_role);
                    modDeadzoneLength = Date.now() - parseInt(this.lastSeenDataChannel.data.mod);
                }
                this.lastSeenDataChannel.data.mod = Date.now();
            }
            if (foundConductor) {
                if (Date.now() > parseInt(this.lastSeenDataChannel.data.conductor) + this.deadzoneMinLengths.conductor) {
                    pinging.push(config.conductor_ping_role);
                    conductorDeadzoneLength = Date.now() - parseInt(this.lastSeenDataChannel.data.conductor);
                }
                this.lastSeenDataChannel.data.conductor = Date.now();
            }

            if (pinging.length == 0) return; // No deadzones ended

            let outputMessage = `${pinging.map(r => "<@&" + r + ">").join(" ")} ${this.playerEmoji(onlinePerson)} **${escapeMarkdown(onlinePerson)}** has joined! Deadzones ended:`;

            if (adminDeadzoneLength) outputMessage += `\n**Admin:** ${prettyMilliseconds(adminDeadzoneLength, { verbose: true })}`;
            if (modDeadzoneLength) outputMessage += `\n**Mod:** ${prettyMilliseconds(modDeadzoneLength, { verbose: true })}`;
            if (conductorDeadzoneLength) outputMessage += `\n**Conductor:** ${prettyMilliseconds(conductorDeadzoneLength, { verbose: true })}`;

            this.client.channels.cache.get(config.ping_channel).send(outputMessage);
            await this.saveData();
        } catch (error) {
            this.statusErrorMessage = error;
            if (this.statusErrorSince == 0) this.statusErrorSince = Date.now();
            logger.error("Error doing status check: " + error);
            if (error.stack) logger.error(error.stack);
            try {
                this.updateStatusMessage();
            } catch (ignored) {
                // If we don't ignore this failing then we'll just end up with an infinite loop
            }
        }
    }

    async saveData() {
        this.lastSeenDataChannel.save();
        this.onlineSinceDataChannel.save();
        this.otherDataChannel.save();
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
            newStatusMessageBuilder.push(`${onlineAdmins.length > 0 ? ":green_square:" : this.redOrOrange("admin")} ${rankEmoji("Admin")} Admin: ${onlineAdmins.length > 0 ? `${onlineAdmins.join(" ")}` : `${this.timestamp(this.lastSeenDataChannel.data.admin)}`} `);
            newStatusMessageBuilder.push(`${onlineMods.length > 0 ? ":green_square:" : this.redOrOrange("mod")} ${rankEmoji("Mod")} Mod: ${onlineMods.length > 0 ? `${onlineMods.join(" ")}` : `${this.timestamp(this.lastSeenDataChannel.data.mod)}`} `);
            newStatusMessageBuilder.push(`${onlineConductors.length > 0 ? ":green_square:" : this.redOrOrange("conductor")} ${rankEmoji("Conductor")} Conductor: ${onlineConductors.length > 0 ? `${onlineConductors.join(" ")}` : `${this.timestamp(this.lastSeenDataChannel.data.conductor)}`} `);

            newStatusMessageBuilder.push(`\n**Staff / Conductors and their Last Seen Dates**`);
            for (const staffMember of staffData) {
                let staffMemberMessage = `${onlineStaff.includes(staffMember) ? ":green_square:" : this.redOrOrange(staffMember.Rank, staffMember.UUID)} ${rankEmoji(staffMember.Rank)} ${this.playerEmoji(staffMember.Name)} ${escapeMarkdown(staffMember.Name)}${onlineStaff.includes(staffMember) ? ": joined " + this.timestamp(this.onlineSinceDataChannel.data[staffMember.UUID]) : `: ${this.lastSeenDataChannel.data[staffMember.UUID] ? this.timestamp(this.lastSeenDataChannel.data[staffMember.UUID]) : ":shrug:"}`}`;

                newStatusMessageBuilder.push(staffMemberMessage);
            }
        }

        newStatusMessageBuilder.push(`\nNext update ${this.timestamp(Date.now() + parseInt(config.check_interval))}`);
        newStatusMessageBuilder.push(`Next skin refresh ${this.timestamp(this.otherDataChannel.data.lastFullEmojiRefresh + parseInt(config.player_emojis_update_interval))}`);

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

    playerEmoji(player) {
        return this.emojis.find(e => e.name == player) ?? "none";
    }

    redOrOrange(rank, uuid) {
        return this.lastSeenDataChannel.data[uuid ?? rank.toLowerCase()] + this.deadzoneMinLengths[rank.toLowerCase()] < Date.now() ? ":red_square:" : ":orange_square:";
    }
}