import { expect, test } from "bun:test";
import { resolve } from "node:path";
import buildConfig from "../../native/embedding/build-config.json";
import darwinTrusted from "../../packages/backend/src/runtime/native/embedding/darwin-arm64.json";
import linuxTrusted from "../../packages/backend/src/runtime/native/embedding/linux-x64.json";
import { stableSha256 } from "./cache-paths";
import { assertNativePatchDigest } from "./source-tree";

const repositoryRoot = resolve(import.meta.dir, "../..");

function expandedCmakeFlags(target: "darwin-arm64" | "linux-x64"): readonly string[] {
  return buildConfig.targets[target].cmakeFlags.map((flag) =>
    flag
      .replace("@BUILD_NUMBER@", buildConfig.source.tag.slice(1))
      .replace(
        "@BUILD_COMMIT@",
        `${buildConfig.source.commit.slice(0, 8)}-lorelum.${buildConfig.patch.sha256.slice(0, 8)}`,
      ),
  );
}

/** The trusted manifests and the reviewed recipe must describe the same build inputs. */
function recipeIdentity(target: "darwin-arm64" | "linux-x64"): string {
  return stableSha256({
    schemaVersion: buildConfig.schemaVersion,
    source: buildConfig.source,
    patchSha256: buildConfig.patch.sha256,
    cmakeFlags: expandedCmakeFlags(target),
    model: buildConfig.model,
  });
}

test("each target's recipe identity still reproduces its trusted manifest", () => {
  expect(recipeIdentity("darwin-arm64")).toBe(darwinTrusted.recipeIdentity);
  expect(recipeIdentity("linux-x64")).toBe(linuxTrusted.recipeIdentity);
});

test("trusted manifests record exactly the expanded recipe flags", () => {
  expect(darwinTrusted.cmakeFlags).toEqual(expandedCmakeFlags("darwin-arm64"));
  expect(linuxTrusted.cmakeFlags).toEqual(expandedCmakeFlags("linux-x64"));
});

test("linux-x64 recipe keeps the generic x86-64 baseline", () => {
  const flags = buildConfig.targets["linux-x64"].cmakeFlags;
  for (const cap of [
    "GGML_NATIVE",
    "GGML_SSE42",
    "GGML_AVX",
    "GGML_AVX2",
    "GGML_BMI2",
    "GGML_FMA",
    "GGML_F16C",
  ])
    expect(flags).toContain(`-D${cap}=OFF`);
  // The darwin-only architecture and deployment flags must not leak into Linux builds.
  for (const flag of flags) expect(flag).not.toMatch(/^-DCMAKE_OSX_|^-DGGML_CPU_ARM_ARCH/);
});

test("reviewed patch file matches its pinned digest", () => {
  expect(() => assertNativePatchDigest(repositoryRoot)).not.toThrow();
});
