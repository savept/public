import path from "node:path";
import ts from "typescript";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";
import { exportEntryAllows, selectExportEntry } from "./exports.mjs";
import {
  dependencyEntries,
  owningPackage,
  recordWorkspaceEdge,
} from "./manifests.mjs";

function packageSpecifier(specifier) {
  const pieces = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (pieces.length < 2) return { name: specifier, subpath: "." };
    return {
      name: `${pieces[0]}/${pieces[1]}`,
      subpath: pieces.length === 2 ? "." : `./${pieces.slice(2).join("/")}`,
    };
  }
  return {
    name: pieces[0],
    subpath: pieces.length === 1 ? "." : `./${pieces.slice(1).join("/")}`,
  };
}

export function validateSpecifier({
  specifier,
  sourcePath,
  owner,
  packages,
  importedWorkspaceDependencies,
  manifestsByName,
  repositoryRoot,
}) {
  if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)) {
    block(
      `absolute source import is not allowed in ${sourcePath}: ${specifier}`,
    );
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) {
    if (specifier.startsWith("node:")) return;
    block(`import protocol is not allowed in ${sourcePath}: ${specifier}`);
  }
  if (specifier.startsWith(".")) {
    const normalized = specifier.replaceAll("\\", "/");
    const resolved = path.resolve(
      path.dirname(path.join(repositoryRoot, sourcePath)),
      normalized,
    );
    if (!isWithin(repositoryRoot, resolved))
      block(
        `relative import escapes repository in ${sourcePath}: ${specifier}`,
      );
    const target = owningPackage(packages, resolved);
    if (target && target.path !== owner.path)
      block(
        `relative import bypasses package boundary in ${sourcePath}: ${specifier}`,
      );
    return;
  }
  const { name, subpath } = packageSpecifier(specifier);
  const target = manifestsByName.get(name);
  if (name.startsWith("@savept/") && !target)
    block(`unknown or private Savept package in ${sourcePath}: ${name}`);
  if (!target) return;
  if (owner.name !== target.name) {
    const declared = dependencyEntries(owner.manifest);
    if (!declared.has(target.name))
      block(
        `local bare import is not declared by ${owner.name}: ${target.name}`,
      );
  }
  const entry = selectExportEntry(target.manifest.exports, subpath);
  if (!exportEntryAllows(entry))
    block(`package subpath is not exported by ${target.name}: ${subpath}`);
  if (owner.path !== target.path)
    recordWorkspaceEdge(importedWorkspaceDependencies, owner, target);
}

const MAX_STATIC_STRING_ANALYSIS_NODES = 1_024;

function staticStringValue(expression) {
  let remainingNodes = MAX_STATIC_STRING_ANALYSIS_NODES;
  function evaluate(node) {
    if (!node) return undefined;
    remainingNodes -= 1;
    if (remainingNodes < 0)
      block("static module specifier analysis exceeded complexity budget");
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return evaluate(node.expression);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (left === undefined || right === undefined) return undefined;
      return left + right;
    }
    return undefined;
  }
  return evaluate(expression);
}

function isRequireResolveCallee(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.name.text === "resolve"
  );
}

function isRequireCallee(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "require";
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "module" &&
      expression.name.text === "require"
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "module" &&
      staticStringValue(expression.argumentExpression) === "require"
    );
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return isRequireCallee(expression.expression);
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    isRequireCallee(expression.right)
  );
}

export function sourceSpecifiers(content, fileName) {
  const source = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const specifier = staticStringValue(node.arguments?.[0]);
      if (
        specifier !== undefined &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          isRequireCallee(node.expression) ||
          isRequireResolveCallee(node.expression))
      ) {
        found.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
