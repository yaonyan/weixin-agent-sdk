import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./index.ts", "./src/bin/weixin-send.ts"],
  dts: true,
});
