export default function wait(time) {
    return new Promise((res, rej) => {
        setTimeout(() => res(), time);
    })
}