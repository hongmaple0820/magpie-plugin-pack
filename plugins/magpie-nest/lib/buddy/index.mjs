// 鹊巢腾讯双产品/双版本渠道：WorkBuddy AI（国际版）、WorkBuddy（中国版）、
// CodeBuddy（中国版）。三个 provider 共享 constants.mjs 的 PRODUCTS 表与
// shared.mjs 的 loader/授权逻辑，只换产品参数。
//
// 入口只导出插件函数：导入本模块的每个函数都会被宿主当作插件调用。

import { PRODUCTS } from "./constants.mjs";
import { buddyPlugin } from "./shared.mjs";

export const WorkBuddyAiPlugin = buddyPlugin(PRODUCTS["workbuddy-ai"]);
export const WorkBuddyPlugin = buddyPlugin(PRODUCTS["workbuddy"]);
export const CodeBuddyPlugin = buddyPlugin(PRODUCTS["codebuddy"]);
