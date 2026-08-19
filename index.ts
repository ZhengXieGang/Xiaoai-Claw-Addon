import { createXiaoaiCloudPlugin } from "./src/provider.js";

type PluginEntry = {
    id: string;
    name: string;
    description: string;
    register(api: any): void;
};

// Match OpenClaw's definePluginEntry export shape without adding a host-SDK
// runtime dependency, so older Gateway installs can still load the plugin.
function definePluginEntry<T extends PluginEntry>(entry: T): T {
    return entry;
}

const pluginEntry = definePluginEntry({
    id: "openclaw-plugin-xiaoai-cloud",
    name: "Xiaoai Speaker Cloud Plugin",
    description: "Direct Xiaomi cloud integration for OpenClaw XiaoAi speaker control.",
    register(api: any) {
        const plugin = createXiaoaiCloudPlugin(api);
        const registrationMode =
            typeof api?.registrationMode === "string"
                ? api.registrationMode
                : "full";
        if (registrationMode === "cli-metadata") {
            return;
        }
        plugin.registerTools(registrationMode);
        if (registrationMode !== "full") {
            return;
        }
        api.registerService({
            id: "xiaoai-cloud-listener",
            start: async (ctx: any) => {
                await plugin.startService(ctx);
            },
            stop: async () => {
                await plugin.stopService();
            }
        });
    }
});

export default pluginEntry;
