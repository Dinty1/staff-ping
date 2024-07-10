import axios from "axios";
export default async function findUUIDs(names) {
    let output = [];
    for (let i = 0; i < names.length; i += 10) {
        let { data } = await axios.post("https://api.mojang.com/profiles/minecraft", names.slice(i, i + 10))
            .catch(error => { 
                throw error;
             });
        if (data) output.push(...data.map(p => p.id));
    }
    return output;
}