import axios from "axios";
export default async function findUUIDs(names) {
    let output = [];
    if (names.length == 0) return [];
    for (let i = 0; i < names.length; i += 10) {
        let { data } = await axios.post("https://api.mojang.com/profiles/minecraft", names.slice(i, i + 10))
            .catch(error => { 
                throw error;
             });
        if (data) output.push(...data.map(p => ({ id: p.id, name: p.name }))); // Brackets do shit for some reason
    }
    return output;
}