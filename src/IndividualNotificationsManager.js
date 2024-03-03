import { MessageActionRow, Modal, TextInputComponent } from "discord.js";
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

                const modal = new Modal()
                    .setCustomId("individual-notifications-editor")
                    .setTitle("Edit Individual Notifications")
                    .addComponents(
                        new MessageActionRow().addComponents(
                            new TextInputComponent()
                                .setCustomId("people")
                                .setLabel("List people to subscribe to. One on each line")
                                .setValue(formContent)
                                .setStyle("PARAGRAPH")
                        )
                    )

                i.showModal(modal);
            } else if (i.customId == "individual-notifications-editor") {
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

                i.editReply(escapeMarkdown(outputMessage));
            }
        });
    }

    async createPrivateThread(user) {
        const thread = await this.pingChannel.threads.create({
            name: user.username,
            type: "GUILD_PRIVATE_THREAD"
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
                        newName: newName ?? null
                    });

                    delete this.dataChannel.data[i].subscribe[j];
                }
            }

            if (!foundPlayers.length > 0) continue;

            let playersFormatted = [];

            for (const player of foundPlayers) {
                if (!player.newName) playersFormatted.push(`**${player.storedName}**`);
                else playersFormatted.push(`**${player.newName}** (${player.storedName})`);
            }

            let thread = (await this.pingChannel.threads.fetch(data[i].thread));

            if (!thread.sendable) {
                await thread.setArchived(false);
            }

            thread.send(`<@${i}> ${humanReadableArrayOutput(playersFormatted.map(p => escapeMarkdown(p)))} ${playersFormatted.length == 1 ? "has" : "have"} joined! They will now be removed from your notification list.`);

            sentNotification = true;
        }

        if (sentNotification) this.dataChannel.save();
    }
}