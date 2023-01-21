import { config } from "./index.js";
import axios from "axios";

export default class PlayerEmojiManager {
    client;
    guild;

    constructor(client) {
        this.client = client;
        this.guild = client.guilds.cache.get(config.guild);
    }

    run() {
        setInterval(() => this.updateEmojis(true), config.player_emojis_update_interval);
    }

    async updateEmojis(refreshCurrent) {
        return new Promise(async (res, rej) => {
            const { data: staffData } = await axios.get(`https://script.google.com/macros/s/AKfycbwde4vwt0l4_-qOFK_gL2KbVAdy7iag3BID8NWu2DQ1566kJlqyAS1Y/exec?spreadsheetId=${config.player_spreadsheet_id}&sheetName=${config.player_spreadsheet_sheet_name}`);

            const emojis = await this.guild.emojis.fetch();

            // In iterator
            // 0 is id
            // 1 is all the other data

            // First delete old ones
            for (const emoji of emojis) {
                if (["Conductor", "Mod", "Admin"].includes(emoji[1].name)) continue;

                if (!staffData.map(s => s.Name).includes(emoji[1].name)) emoji[1].delete();
            }

            // Then go through staff members and see what needs to be updated
            for (const staffMember of staffData) {
                let emoji = emojis.find(e => e.name == staffMember.Name);

                if (emoji && refreshCurrent) await this.guild.emojis.delete(emoji); // Too hard to compare skins with diff compression so just delete and recreate every so often

                if ((emoji && refreshCurrent) || !emoji) {
                    let { data: currentSkin } = await axios.get("https://crafatar.com/avatars/" + staffMember.UUID + "?overlay", { responseType: "arraybuffer" });
                    await this.guild.emojis.create(Buffer.from(currentSkin, "base64"), staffMember.Name);
                }
            }
            res();
        })

    }
}