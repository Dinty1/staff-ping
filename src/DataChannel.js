export default class DataChannel {
    data;
    channelId
    channel;
    client;

    constructor(channelId, client) {
        this.channelId = channelId;
        this.client = client;
        this.channel = client.channels.cache.get(channelId);
        this.channel.messages.fetch({ limit: 100 }).then(messages => {
            let dataRaw = "";
            for (const message of messages.reverse().values()) {
                dataRaw += message.content;
            }
            if (dataRaw == "") {
                this.data = {};
                this.save();
            } else this.data = JSON.parse(dataRaw);
        })
    }

    async save() {
        let dataChunks = [];
        let rawData = JSON.stringify(this.data);

        // hail ye o stack overflow
        dataChunks = rawData.match(/(.|[\r\n]){1,2000}/g);

        let messages = (await this.channel.messages.fetch({ limit: 100 })).reverse().values();

        for (const message of messages) {
            if (dataChunks.length > 0) message.edit(dataChunks.shift());
            else message.delete();
        }

        for (const remainingChunk of dataChunks) {
            await this.channel.send(remainingChunk);
        }
    }
}