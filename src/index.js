import { Client, Intents, MessageActionRow, MessageButton } from "discord.js";
import { config as dotenvConfig } from "dotenv";
import ServerMonitor from "./ServerMonitor.js";
import fs from "fs";

dotenvConfig();

const intents = new Intents();
intents.add(Intents.FLAGS.GUILDS);
intents.add(Intents.FLAGS.GUILD_MEMBERS);
const client = new Client({ intents: intents });

export const config = JSON.parse(fs.readFileSync("./config.json"));

client.on("ready", () => {
    console.info("Client logged in as " + client.user.tag);
    new ServerMonitor(client).run();
    /*
    const row = new MessageActionRow();
    row.addComponents(new MessageButton().setCustomId("subscribe-conductor").setLabel("Conductor").setStyle("PRIMARY"));
    row.addComponents(new MessageButton().setCustomId("subscribe-mod").setLabel("Mod").setStyle("SECONDARY"));
    row.addComponents(new MessageButton().setCustomId("subscribe-admin").setLabel("Admin").setStyle("PRIMARY"));
    row.addComponents(new MessageButton().setCustomId("remove-subscription").setLabel("Remove All").setStyle("DANGER"));

    let messageContent = "**Change your notification preferences here!**";
    messageContent += "\n- If you're waiting for anyone who can do a worldedit, subscribe to Conductor notifications.";
    messageContent += "\n- If you're waiting for anyone who can do mod things like block checks or town endorsements, subscribe to Mod notifications.";
    messageContent += "\n- If you're waiting for admins for rollbacks or the like, subscribe to Admin notifications.";
    messageContent += "\n- You can remove each individual preference by pressing the button again or remove all by pressing the Remove All button."

    client.channels.cache.get("811724497619124234").send({ content: messageContent, components: [row] })*/
});

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
    outputMessage += `**Conductor Notifications:** ${i.member.roles.cache.has(config.conductor_ping_role) ? "On" : "Off"}\n`;
    outputMessage += `**Mod Notifications:** ${i.member.roles.cache.has(config.mod_ping_role) ? "On" : "Off"}\n`;
    outputMessage += `**Admin Notifications:** ${i.member.roles.cache.has(config.admin_ping_role) ? "On" : "Off"}`;

    i.reply({ content: outputMessage, ephemeral: true });
}

client.login(process.env.TOKEN);