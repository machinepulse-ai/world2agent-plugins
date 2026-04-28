export async function readJsonFromStdin() {
    process.stdin.setEncoding("utf8");
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    const text = raw.trim();
    if (!text)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Invalid sensor config JSON on stdin: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Sensor config JSON must be an object");
    }
    return parsed;
}
