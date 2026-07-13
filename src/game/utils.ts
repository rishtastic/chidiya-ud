export function selectRandom<Type>(arr: Type[]): Type {
    const random = Math.floor(Math.random() * arr.length);
    return arr[random]
}

export function bolo(term: string) {
    const utterance = new SpeechSynthesisUtterance(term);
    utterance.lang = "hi-IN";
    speechSynthesis.speak(utterance);
}
