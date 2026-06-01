import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sourceIdentifier = "com.j1coding.armsx2.ios";
export const bundleIdentifier = "com.armsx2.ios";
export const defaultBaseUrl = "https://j1coding.github.io/Armsx2-Repo";
