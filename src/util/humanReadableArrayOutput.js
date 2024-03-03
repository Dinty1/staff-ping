export default function humanReadableArrayOutput(array) {
    let result = array;
    if (result.length > 1) result.splice(array.length - 1, 0, "and");
    return result.join(", ").replace(", and,", " and");
}