import { loadMcpSettings, saveMcpSettings } from "../utils/config.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export async function handleMcpGetSettings(cwd: string): Promise<ToolResult> {
    const settings = await loadMcpSettings(cwd);
    return {
        content: [{ type: "text", text: JSON.stringify(settings, null, 2) }],
    };
}

export async function handleMcpSetSettings(
    cwd: string,
    settings: { deep_default_mode?: string }
): Promise<ToolResult> {
    const value = settings.deep_default_mode;
    if (value !== "off" && value !== "quick" && value !== "full") {
        return {
            content: [{ type: "text", text: "Invalid deep_default_mode. Use one of: off, quick, full." }],
            isError: true,
        };
    }

    await saveMcpSettings(cwd, { deep_default_mode: value });
    return {
        content: [{ type: "text", text: `Saved MCP settings: deep_default_mode=${value}` }],
    };
}
