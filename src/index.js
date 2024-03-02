import { Client, Intents, MessageActionRow, MessageButton } from "discord.js";
import { config as dotenvConfig } from "dotenv";
import ServerMonitor from "./ServerMonitor.js";
import fs from "fs";
import * as logger from "./util/log.js";
import PlayerEmojiManager from "./PlayerEmojiManager.js";
import LeaveListener from "./LeaveListener.js";
import rankEmoji from "./util/rankEmoji.js";

dotenvConfig();

const intents = new Intents();
intents.add(Intents.FLAGS.GUILDS);
intents.add(Intents.FLAGS.GUILD_MEMBERS);
const client = new Client({ intents: intents });

export const config = JSON.parse(fs.readFileSync("./config.json"));

client.on("ready", async () => {
    logger.info("Client logged in as " + client.user.tag);
    let emojiManager = new PlayerEmojiManager(client);
    new ServerMonitor(client, emojiManager).run();
    new LeaveListener(client);

    const subscribeChannelMessages = await client.channels.cache.get(config.subscribe_channel).messages.fetch({ limit: 1 });
    if (subscribeChannelMessages.size == 0) {
        const row = new MessageActionRow();
        row.addComponents(
            subscribeButton("Conductor"),
            subscribeButton("Mod"),
            subscribeButton("Admin"),
            new MessageButton().setCustomId("remove-subscription").setLabel("Remove All").setStyle("DANGER")
        );

        let messageContent = "**Change your notification preferences here!**";
        messageContent += "\n- If you're waiting for anyone who can do a worldedit, subscribe to Conductor notifications.";
        messageContent += "\n- If you're waiting for anyone who can do mod things like block checks or town endorsements, subscribe to Mod notifications.";
        messageContent += "\n- If you're waiting for admins for rollbacks or the like, subscribe to Admin notifications.";
        messageContent += "\n- You can remove each individual preference by pressing the button again or remove all by pressing the Remove All button."
        messageContent += "\n**Note:** If you only want a worldedit, you _only need_ to enable Conductor notifications. Mods and Admins are automatically designated as Conductors.";

        client.channels.cache.get("811724497619124234").send({ content: messageContent, components: [row] })
    }
});

function subscribeButton(rank) {
    return new MessageButton().setCustomId("subscribe-" + rank.toLowerCase()).setLabel(rank).setStyle("PRIMARY").setEmoji(rankEmoji(rank));
}

client.on("interactionCreate", async i => {
    if (!i.isButton()) return;

    switch (i.customId) {
        case "subscribe-conductor":
            toggleRole(i.member, config.conductor_ping_role, i);
            break;
        case "subscribe-mod":
            toggleRole(i.member, config.mod_ping_role, i);
            break;
        case "subscribe-admin":
            toggleRole(i.member, config.admin_ping_role, i);
            break;
        case "remove-subscription":
            await i.member.roles.remove([config.conductor_ping_role, config.mod_ping_role, config.admin_ping_role]);
            replyToPreferenceUpdateWithCurrentPreferences(i);
            break;
    }
})

async function toggleRole(member, role, interaction) {
    if (!member.roles.cache.has(role)) await member.roles.add(role);
    else await member.roles.remove(role);
    replyToPreferenceUpdateWithCurrentPreferences(interaction);
}

function replyToPreferenceUpdateWithCurrentPreferences(i) {
    let outputMessage = "Updated! Here are your current preferences:\n";
    outputMessage += `**Conductor Notifications:** ${i.member.roles.cache.has(config.conductor_ping_role) ? ":white_check_mark:" : ":x:"}\n`;
    outputMessage += `**Mod Notifications:** ${i.member.roles.cache.has(config.mod_ping_role) ? ":white_check_mark:" : ":x:"}\n`;
    outputMessage += `**Admin Notifications:** ${i.member.roles.cache.has(config.admin_ping_role) ? ":white_check_mark:" : ":x:"}`;

    i.reply({ content: outputMessage, ephemeral: true });
}

client.login(process.env.TOKEN);

if (!process.env.DEV) {
    // We're being asked to shut down
    process.once("SIGTERM", async () => {
        logger.info("SIGTERM received. Gracefully shutting down.");
        client.user.setStatus("invisible");
        await client.channels.cache.get(config.private_stuff_channel).send("SIGTERM received. Probably updating...");
        // Can't await the status thing but probably gonna take a small while
        setTimeout(() => process.exit(), 2000)
    })
}