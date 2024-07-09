import { ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder } from "discord.js";
import DataChannel from "./DataChannel.js";
import { config } from "./index.js"
import axios from "axios";
import escapeMarkdown from "./util/escapeMarkdown.js";
import humanReadableArrayOutput from "./util/humanReadableArrayOutput.js";

export default class IndividualNotificationsManager {
    client;
    dataChannel;
    pingChannel;

    constructor(client) {
        this.client = client;
        this.dataChannel = new DataChannel(config.individual_notifications_storage_channel, client);
        this.pingChannel = client.channels.cache.get(config.ping_channel);

        client.on("interactionCreate", async i => {
            if (i.customId == "edit-individual-notifications") {
                if (!this.dataChannel.data[i.user.id]) {
                    this.dataChannel.data[i.user.id] = {
                        subscribe: {},
                        ownUsername: i.user.username
                    }
                    this.dataChannel.save();
                }

                let alreadySubscribed = this.dataChannel.data[i.user.id].subscribe;

                let formContent = "";
                for (let i in alreadySubscribed) {
                    formContent += `${alreadySubscribed[i].name} | ${i}\n`;
                }

                const modal = new ModalBuilder()
                    .setCustomId("individual-notifications-editor" + Math.floor(Math.random() * 99999)) // Append gibberish to bypass client cache that we don't want
                    .setTitle("Edit Individual Notifications")
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("people")
                                .setLabel("List people to subscribe to. One on each line")
                                .setValue(formContent)
                                .setStyle("Paragraph")
                        )
                    )

                i.showModal(modal);
            } else if (i.customId.startsWith("individual-notifications-editor")) {
                await i.deferReply({ ephemeral: true });
                const input = i.fields.getTextInputValue("people");
                let entries = input.split("\n");
                let newEntries = {};
                let names = [];
                let failedToFetch = [];

                for (const line of entries) {
                    let splitLine = line.split("|").map(v => v.trim());
                    if (splitLine.length == 2) newEntries[splitLine[1]] = { name: splitLine[0] }
                    else names.push(splitLine[0]);
                }

                for (const name of names) {
                    let data = await this.getPlayerProfile(name);


                    if (!data) failedToFetch.push(name);
                    else newEntries[data.data.player.raw_id] = { name: data.data.player.username };
                }

                this.dataChannel.data[i.user.id].subscribe = newEntries;
                if (!this.dataChannel.data[i.user.id].thread && Object.keys(newEntries).length > 0) this.dataChannel.data[i.user.id].thread = await this.createPrivateThread(i.user)
                this.dataChannel.save();

                let outputMessage = "**Now watching for these people:**\n";

                for (let i in newEntries) {
                    outputMessage += `${newEntries[i].name} (${i})\n`;
                }

                if (failedToFetch.length > 0) outputMessage += `\n**Failed to find accounts for these names:** ${failedToFetch.join(", ")}`;

                outputMessage += "\n*Edit the below menu to only be pinged when you have a certain status **on Discord***"

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("statuspings")
                        .setPlaceholder("Only ping when you have these statuses")
                        .setOptions({
                            label: "Online",
                            value: "online"
                        }, {
                            label: "Idle",
                            value: "idle"
                        }, {
                            label: "DND",
                            value: "dnd"
                        }, {
                            label: "Offline",
                            value: "offline"
                        })
                        .setMaxValues(4)
                )

                i.editReply({ content: escapeMarkdown(outputMessage), components: [row] });
            } else if (i.customId == "statuspings") {
                this.dataChannel.data[i.user.id].statuses = i.values;
                let msg = "Now only pinging you if a person joins and you have one of these statuses: " + humanReadableArrayOutput(i.values.map(s => `**${s}**`));
                this.sendToThread(this.dataChannel.data[i.user.id].thread, msg);
                this.dataChannel.save();
                i.reply({ content: msg, ephemeral: true });
            }
        });
    }

    async createPrivateThread(user) {
        const thread = await this.pingChannel.threads.create({
            name: user.username,
            type: "GuildPrivateThread"
        })
        thread.send(`<@${user.id}> Welcome to your private notification thread. Please note that Dinty can see this so don't do anything too wild :)`)
        return thread.id;
    }

    async getPlayerProfile(identifier) {
        try {
            let data = (await axios.get("https://playerdb.co/api/player/minecraft/" + identifier, {
                "User-Agent": "github/Dinty1/Staff-Ping"
            })).data;

            if (!data || !data.data.player) return null;
            else return data;
        } catch (err) {
            return null
        }
    }

    async reportServerPlayers(uuids, names) {
        let data = this.dataChannel.data;
        let sentNotification = false;

        for (let i in data) {
            // Check if status criteria are matched
            let sendPing = true;
            let member;
            try {
                member = await this.client.guilds.cache.get(config.guild).members.fetch(i);
            } catch (apiError) {
                continue;
            }
            const status = member.presence?.status ?? "offline";
            if (data[i].statuses && !data[i].statuses.includes(status)) sendPing = false;

            let foundPlayers = [];
            for (let j in data[i].subscribe) {
                if (uuids.includes(j)) {
                    let storedName = data[i].subscribe[j].name;
                    let newName;
                    if (!names.includes(storedName)) {
                        // Name has changed
                        let profileData = await this.getPlayerProfile(j);
                        if (profileData) newName = profileData.data.player.username;
                    }

                    foundPlayers.push({
                        storedName: storedName,
                        newName: newName ?? null,
                        uuid: j
                    });

                    if (sendPing) delete this.dataChannel.data[i].subscribe[j];
                }
            }

            if (!foundPlayers.length > 0) continue;

            let playersFormatted = [];

            for (const player of foundPlayers) {
                if (!player.newName) playersFormatted.push(`**${player.storedName}**`);
                else playersFormatted.push(`**${player.newName}** (${player.storedName})`);
            }

            const playerList = humanReadableArrayOutput(playersFormatted.map(p => escapeMarkdown(p)));

            if (!sendPing) {
                // If one of the players should have a message sent about them we may as well include the whole list even if it hasn't been 24h
                let shouldAnnounce = false;
                for (const player of foundPlayers) {
                    if (!this.dataChannel.data[i].subscribe[player.uuid].lastAnnounced || ((this.dataChannel.data[i].subscribe[player.uuid].lastAnnounced + 1000 * 60 * 60 * 24) < Date.now())) shouldAnnounce = true;
                }
                if (!shouldAnnounce) continue;

                await this.sendToThread(data[i].thread, `${playerList} ${playersFormatted.length == 1 ? "is" : "are"} online but your status is **${status}** and you requested only to be pinged when you have these statuses: ${humanReadableArrayOutput(data[i].statuses.map(s => `**${s}**`))}`);
                sentNotification = true;
                // Now update all the last announced times
                for (const player of foundPlayers) this.dataChannel.data[i].subscribe[player.uuid].lastAnnounced = Date.now();
                continue;
            }

            await this.sendToThread(data[i].thread, `<@${i}> ${playerList} ${playersFormatted.length == 1 ? "is" : "are"} online! They will now be removed from your notification list.`);

            sentNotification = true;
        }

        if (sentNotification) this.dataChannel.save();
    }

    async sendToThread(id, message) {
        let thread = (await this.pingChannel.threads.fetch(id));

        if (!thread.sendable) {
            await thread.setArchived(false);
        }

        await thread.send(message)
    }
}