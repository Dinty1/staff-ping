export function info(message) {
    console.info(`[${new Date().toUTCString()} INFO] ${message}`);
}

export function error(message) {
    console.error(`[${new Date().toUTCString()} ERROR] ${message}`);
}