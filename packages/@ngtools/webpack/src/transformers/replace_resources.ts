import * as ts from 'typescript';

import { findAstNodes, getFirstNode } from './ast_helpers';
import {
  AddNodeOperation,
  ReplaceNodeOperation,
  TransformOperation
} from './make_transform';


export function replaceResources(sourceFile: ts.SourceFile): TransformOperation[] {
  const ops: TransformOperation[] = [];
  const replacements = findResources(sourceFile);

  if (replacements.length > 0) {

    // Add the replacement operations.
    ops.push(...(replacements.map((rep) => rep.replaceNodeOperation)));

    // If we added a require call, we need to also add typings for it.
    // The typings need to be compatible with node typings, but also work by themselves.

    // interface NodeRequire {(id: string): any;}
    const nodeRequireInterface = ts.createInterfaceDeclaration([], [], 'NodeRequire', [], [], [
      ts.createCallSignature([], [
        ts.createParameter([], [], undefined, 'id', undefined,
          ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
        )
      ], ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))
    ]);

    // declare var require: NodeRequire;
    const varRequire = ts.createVariableStatement(
      [ts.createToken(ts.SyntaxKind.DeclareKeyword)],
      [ts.createVariableDeclaration('require', ts.createTypeReferenceNode('NodeRequire', []))]
    );

    ops.push(new AddNodeOperation(sourceFile, getFirstNode(sourceFile), nodeRequireInterface));
    ops.push(new AddNodeOperation(sourceFile, getFirstNode(sourceFile), varRequire));
  }

  return ops;
}

export interface ResourceReplacement {
  resourcePaths: string[];
  replaceNodeOperation: ReplaceNodeOperation;
}

export function findResources(sourceFile: ts.SourceFile): ResourceReplacement[] {
  const replacements: ResourceReplacement[] = [];

  // Find all object literals.
  findAstNodes<ts.ObjectLiteralExpression>(null, sourceFile,
    ts.SyntaxKind.ObjectLiteralExpression, true)
    // Get all their property assignments.
    .map(node => findAstNodes<ts.PropertyAssignment>(node, sourceFile,
      ts.SyntaxKind.PropertyAssignment))
    // Flatten into a single array (from an array of array<property assignments>).
    .reduce((prev, curr) => curr ? prev.concat(curr) : prev, [])
    // We only want property assignments for the templateUrl/styleUrls keys.
    .filter((node: ts.PropertyAssignment) => {
      const key = _getContentOfKeyLiteral(node.name);
      if (!key) {
        // key is an expression, can't do anything.
        return false;
      }
      return key == 'templateUrl' || key == 'styleUrls';
    })
    // Replace templateUrl/styleUrls key with template/styles, and and paths with require('path').
    .forEach((node: ts.PropertyAssignment) => {
      const key = _getContentOfKeyLiteral(node.name);

      if (key == 'templateUrl') {
        const resourcePath = _getResourceRequest(node.initializer, sourceFile);
        const requireCall = _createRequireCall(resourcePath);
        const propAssign = ts.createPropertyAssignment('template', requireCall);
        replacements.push({
          resourcePaths: [resourcePath],
          replaceNodeOperation: new ReplaceNodeOperation(sourceFile, node, propAssign)
        });
      } else if (key == 'styleUrls') {
        const arr = findAstNodes<ts.ArrayLiteralExpression>(node, sourceFile,
          ts.SyntaxKind.ArrayLiteralExpression, false);
        if (!arr || arr.length == 0 || arr[0].elements.length == 0) {
          return;
        }

        const stylePaths = arr[0].elements.map((element: ts.Expression) => {
          return _getResourceRequest(element, sourceFile);
        });

        const requireArray = ts.createArrayLiteral(
          stylePaths.map((path) => _createRequireCall(path))
        );

        const propAssign = ts.createPropertyAssignment('styles', requireArray);
        replacements.push({
          resourcePaths: stylePaths,
          replaceNodeOperation: new ReplaceNodeOperation(sourceFile, node, propAssign)
        });
      }
    });

  return replacements;
}

function _getContentOfKeyLiteral(node?: ts.Node): string | null {
  if (!node) {
    return null;
  } else if (node.kind == ts.SyntaxKind.Identifier) {
    return (node as ts.Identifier).text;
  } else if (node.kind == ts.SyntaxKind.StringLiteral) {
    return (node as ts.StringLiteral).text;
  } else {
    return null;
  }
}

function _getResourceRequest(element: ts.Expression, sourceFile: ts.SourceFile) {
  if (element.kind == ts.SyntaxKind.StringLiteral) {
    const url = (element as ts.StringLiteral).text;
    // If the URL does not start with ./ or ../, prepends ./ to it.
    return `${/^\.?\.\//.test(url) ? '' : './'}${url}`;
  } else {
    // if not string, just use expression directly
    return element.getFullText(sourceFile);
  }
}

function _createRequireCall(path: string) {
  return ts.createCall(
    ts.createIdentifier('require'),
    [],
    [ts.createLiteral(path)]
  );
}
