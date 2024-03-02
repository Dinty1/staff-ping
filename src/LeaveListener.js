import { config } from "./index.js"

export default class LeaveListener {
    constructor(client) {
        client.guilds.cache.get(config.guild).members.fetch();
        client.on("guildMemberRemove", member => {
            client.channels.cache.get(config.general_channel).send(`:red_circle: ${member.user} left.`)
        })
    }
}