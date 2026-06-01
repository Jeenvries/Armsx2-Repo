#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { parseOptions, setOptionFlag, setOptionValue } from "./cli.js";
import { defaultBaseUrl, repositoryRoot } from "./constants.js";

const execFileAsync = promisify(execFile);
const generatorPath = resolve(repositoryRoot, "scripts/generate-source.js");
const validatorPath = resolve(repositoryRoot, "scripts/validate-source.js");

class UpstreamSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamSyncError";
  }
}

const defaults = {
  metadataPath: "metadata/store.json",
  checksumsPath: "checksums.json",
  outputDirectory: "ipas",
  baseUrl: process.env.ARMSX2_PUBLIC_BASE_URL || defaultBaseUrl,
  upstreamReleaseRepo: process.env.ARMSX2_UPSTREAM_RELEASE_REPO || null,
  includePrereleases: process.env.INCLUDE_PRERELEASES === "true",
};

const parseArguments = (cliArguments) => parseOptions(
  cliArguments,
  defaults,
  {
    "--metadata": setOptionValue("metadataPath"),
    "--checksums": setOptionValue("checksumsPath"),
    "--output-dir": setOptionValue("outputDirectory"),
    "--base-url": setOptionValue("baseUrl"),
    "--upstream-release-repo": setOptionValue("upstreamReleaseRepo"),
    "--include-prereleases": setOptionFlag("includePrereleases"),
  },
  (message) => new UpstreamSyncError(message),
);

const jsonDocument = async (jsonPath, fallbackPayload = {}) => {
  try {
    return JSON.parse(await readFile(jsonPath, "utf8"));
  } catch (filesystemError) {
    if (filesystemError?.code === "ENOENT") {
      return fallbackPayload;
    }

    throw filesystemError;
  }
};

const releaseRepository = async (syncOptions) => {
  const metadataPath = resolve(repositoryRoot, syncOptions.metadataPath);
  const metadataPayload = await jsonDocument(metadataPath);
  const repositoryName = syncOptions.upstreamReleaseRepo
    ?? metadataPayload.releaseNotes?.upstreamRepository;

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName ?? "")) {
    throw new UpstreamSyncError(`Invalid upstream release repository: ${repositoryName}`);
  }

  return repositoryName;
};

const githubHeaders = (accept = "application/vnd.github+json") => {
  const headers = {
    Accept: accept,
    "User-Agent": "J1coding-ARMSX2-Source-Updater/2.1",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
};

const githubReleases = async (repositoryName) => {
  const releaseResponse = await fetch(`https://api.github.com/repos/${repositoryName}/releases?per_page=100`, {
    headers: githubHeaders(),
  });

  if (!releaseResponse.ok) {
    throw new UpstreamSyncError(`GitHub release lookup failed: ${releaseResponse.status}`);
  }

  const releasePayload = await releaseResponse.json();

  if (!Array.isArray(releasePayload)) {
    throw new UpstreamSyncError("GitHub release lookup returned an unexpected payload.");
  }

  return releasePayload;
};

const releaseTimestamp = (githubRelease) =>
  String(githubRelease.published_at ?? githubRelease.created_at ?? "");

const releaseCandidates = (releases, syncOptions) =>
  releases
    .filter((githubRelease) => !githubRelease.draft)
    .filter((githubRelease) => syncOptions.includePrereleases || !githubRelease.prerelease)
    .flatMap((githubRelease) =>
      (githubRelease.assets ?? [])
        .filter((releaseAsset) => releaseAsset.name?.toLowerCase().endsWith(".ipa"))
        .map((releaseAsset) => ({ githubRelease, releaseAsset })),
    )
    .sort((leftCandidate, rightCandidate) =>
      releaseTimestamp(rightCandidate.githubRelease).localeCompare(releaseTimestamp(leftCandidate.githubRelease)),
    );

const selectedReleaseCandidate = (candidates) => {
  const iosCandidate = candidates.find(({ githubRelease, releaseAsset }) =>
    `${githubRelease.tag_name ?? ""} ${githubRelease.name ?? ""} ${releaseAsset.name ?? ""}`.match(/ios/i),
  );

  return iosCandidate ?? candidates[0] ?? null;
};

const downloadAssetToFile = async (releaseAsset, outputPath) => {
  const assetResponse = await fetch(releaseAsset.url, {
    headers: githubHeaders("application/octet-stream"),
  });

  if (!assetResponse.ok) {
    throw new UpstreamSyncError(`IPA download failed: ${assetResponse.status}`);
  }

  if (!assetResponse.body) {
    throw new UpstreamSyncError("IPA download returned an empty response body.");
  }

  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(assetResponse.body),
    hashingStream,
    createWriteStream(outputPath),
  );

  return hash.digest("hex");
};

const checksumExists = async (syncOptions, ipaSha256) => {
  const checksumPath = resolve(repositoryRoot, syncOptions.checksumsPath);
  const checksumPayload = await jsonDocument(checksumPath, { files: [] });

  return (checksumPayload.files ?? []).some((fileEntry) => fileEntry.sha256 === ipaSha256);
};

const safeAssetName = (assetName) =>
  basename(assetName).replace(/[^\w.-]/gu, "-");

const writeGithubOutput = async (outputPayload) => {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const outputLines = Object.entries(outputPayload)
    .map(([outputKey, outputValue]) => `${outputKey}=${String(outputValue).replaceAll("\n", " ")}`)
    .join("\n");

  await writeFile(process.env.GITHUB_OUTPUT, `${outputLines}\n`, { flag: "a" });
};

const runNodeScript = async (scriptPath, scriptArguments, extraEnvironment = {}) => {
  await execFileAsync(process.execPath, [scriptPath, ...scriptArguments], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...extraEnvironment,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
};

const validateCandidate = async (temporaryDirectory, candidateIpaDirectory, syncOptions) => {
  const candidateSourcePath = join(temporaryDirectory, "apps.json");
  const candidateChecksumsPath = join(temporaryDirectory, "checksums.json");

  await runNodeScript(generatorPath, [
    "--input-dir",
    candidateIpaDirectory,
    "--output",
    candidateSourcePath,
    "--checksums",
    candidateChecksumsPath,
    "--base-url",
    syncOptions.baseUrl,
    "--require-ipa",
  ]);

  await runNodeScript(validatorPath, [
    "--source",
    candidateSourcePath,
    "--checksums",
    candidateChecksumsPath,
    "--skip-offline-fallback",
    "--skip-legacy-purge",
  ]);
};

const replacePublishedIpas = async (candidateIpaPath, syncOptions) => {
  const outputDirectory = resolve(repositoryRoot, syncOptions.outputDirectory);
  const outputIpaPath = join(outputDirectory, basename(candidateIpaPath));

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(candidateIpaPath, outputIpaPath);

  return outputIpaPath;
};

const syncLatestIpa = async () => {
  const syncOptions = parseArguments(process.argv.slice(2));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "armsx2-upstream-"));

  try {
    const repositoryName = await releaseRepository(syncOptions);
    const releases = await githubReleases(repositoryName);
    const releaseCandidate = selectedReleaseCandidate(releaseCandidates(releases, syncOptions));

    if (!releaseCandidate) {
      throw new UpstreamSyncError(`No IPA release asset found in ${repositoryName}.`);
    }

    const { githubRelease, releaseAsset } = releaseCandidate;
    const assetName = safeAssetName(releaseAsset.name);
    const candidateIpaPath = join(temporaryDirectory, "ipas", assetName);
    const versionLabel = githubRelease.tag_name ?? githubRelease.name ?? assetName;
    const ipaSha256 = await downloadAssetToFile(releaseAsset, candidateIpaPath);

    if (await checksumExists(syncOptions, ipaSha256)) {
      await writeGithubOutput({
        changed: "false",
        asset_name: assetName,
        version: versionLabel,
        sha256: ipaSha256,
      });
      console.log(`No update: ${assetName} is already published (${ipaSha256}).`);
      return;
    }

    await validateCandidate(temporaryDirectory, dirname(candidateIpaPath), syncOptions);
    const publishedIpaPath = await replacePublishedIpas(candidateIpaPath, syncOptions);

    await writeGithubOutput({
      changed: "true",
      asset_name: assetName,
      version: versionLabel,
      sha256: ipaSha256,
    });

    console.log(`Published ${publishedIpaPath} from ${repositoryName} (${ipaSha256}).`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

try {
  await syncLatestIpa();
} catch (syncError) {
  console.error(syncError instanceof Error ? syncError.message : syncError);
  process.exitCode = 1;
}
