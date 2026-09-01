import path from "node:path";
import ts from "typescript";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";
import { owningPackage, recordWorkspaceEdge } from "./manifests.mjs";
import { validateSpecifier } from "./specifier.mjs";

function normalizeConfigPath(value, label, configPath) {
  if (typeof value !== "string" || !value.trim())
    block(`${label} in ${configPath} must be a path string`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[a-z][a-z\d+.-]*:/i.test(normalized)
  ) {
    block(
      `tsconfig ${label} has an unsafe config path in ${configPath}: ${value}`,
    );
  }
  return normalized;
}

function resolveConfigPath(
  repositoryRoot,
  configPath,
  value,
  label,
  { baseDirectory } = {},
) {
  const normalized = normalizeConfigPath(value, label, configPath);
  const resolved = path.resolve(
    baseDirectory ?? path.dirname(path.join(repositoryRoot, configPath)),
    normalized,
  );
  if (!isWithin(repositoryRoot, resolved))
    block(`tsconfig ${label} escapes repository in ${configPath}: ${value}`);
  return resolved;
}

function validateExtends({
  repositoryRoot,
  configPath,
  value,
  owner,
  manifestsByName,
}) {
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.length === 0)
    block(
      `tsconfig extends in ${configPath} must be a non-empty string or array`,
    );
  for (const entry of entries) {
    const normalized = normalizeConfigPath(entry, "extends", configPath);
    if (normalized.startsWith("."))
      resolveConfigPath(repositoryRoot, configPath, normalized, "extends");
    else {
      validateSpecifier({
        specifier: normalized,
        sourcePath: configPath,
        owner,
        manifestsByName,
        repositoryRoot,
      });
    }
  }
}

export function validateTsconfig({
  repositoryRoot,
  configPath,
  content,
  packages,
  manifestsByName,
}) {
  const parsed = ts.parseConfigFileTextToJson(configPath, content);
  if (parsed.error) {
    const detail = ts.flattenDiagnosticMessageText(
      parsed.error.messageText,
      " ",
    );
    block(`tsconfig ${configPath} is invalid JSONC: ${detail}`);
  }
  const config = parsed.config;
  const configOwner = owningPackage(
    packages,
    path.join(repositoryRoot, configPath),
  );
  if (config.extends !== undefined)
    validateExtends({
      repositoryRoot,
      configPath,
      value: config.extends,
      owner: configOwner,
      manifestsByName,
    });
  if (config.references !== undefined) {
    if (!Array.isArray(config.references))
      block(`tsconfig references in ${configPath} must be an array`);
  }
  const compilerOptions = config.compilerOptions ?? {};
  let pathsBase = path.dirname(path.join(repositoryRoot, configPath));
  if (compilerOptions.baseUrl !== undefined) {
    pathsBase = resolveConfigPath(
      repositoryRoot,
      configPath,
      compilerOptions.baseUrl,
      "baseUrl",
    );
    const baseUrlOwner = owningPackage(packages, pathsBase);
    if (
      !configOwner ||
      (baseUrlOwner && baseUrlOwner.path !== configOwner.path)
    ) {
      block(`tsconfig baseUrl bypasses package exports in ${configPath}`);
    }
  }
  if (compilerOptions.paths !== undefined) {
    if (
      !compilerOptions.paths ||
      typeof compilerOptions.paths !== "object" ||
      Array.isArray(compilerOptions.paths)
    ) {
      block(`tsconfig paths in ${configPath} must be an object`);
    }
    for (const [alias, targets] of Object.entries(compilerOptions.paths)) {
      if (!Array.isArray(targets) || targets.length === 0)
        block(`tsconfig paths target for ${alias} is malformed`);
      for (const target of targets) {
        const normalized = normalizeConfigPath(
          target,
          `paths target for ${alias}`,
          configPath,
        );
        const resolved = path.resolve(
          pathsBase,
          normalized.replace(/\*.*$/, ""),
        );
        if (!isWithin(repositoryRoot, resolved))
          block(
            `tsconfig paths target escapes repository in ${configPath}: ${target}`,
          );
        if (owningPackage(packages, resolved)) {
          block(
            `tsconfig path alias bypasses package exports in ${configPath}: ${alias}`,
          );
        }
      }
    }
  }
  return { config, owner: configOwner };
}

export function validateProjectReferences({
  repositoryRoot,
  configPath,
  config,
  owner,
  packages,
  validatedTsconfigs,
  projectReferences,
}) {
  if (config.references === undefined) return;
  for (const reference of config.references) {
    const resolved = resolveConfigPath(
      repositoryRoot,
      configPath,
      reference?.path,
      "reference path",
    );
    const targetConfigPath =
      path.extname(resolved).toLowerCase() === ".json"
        ? resolved
        : path.join(resolved, "tsconfig.json");
    const relativeTargetPath = path.relative(repositoryRoot, targetConfigPath);
    const target = validatedTsconfigs.get(relativeTargetPath);
    if (!target) {
      block(
        `tsconfig project reference does not resolve to an inventoried tsconfig in ${configPath}: ${reference.path}`,
      );
    }
    if (!target.owner || !owningPackage(packages, targetConfigPath)) {
      block(
        `tsconfig project reference must resolve to a workspace package config in ${configPath}: ${reference.path}`,
      );
    }
    recordWorkspaceEdge(projectReferences, owner, target.owner);
  }
}
