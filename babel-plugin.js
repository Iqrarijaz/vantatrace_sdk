const { addNamed } = require('@babel/helper-module-imports');

const RUNTIME_IMPORT_SOURCE = '@vantatrace/sdk/runtime';
const IMPORTED_FUNCTION_NAME = 'captureExceptionGlobal';
const IGNORE_DIRECTIVE = 'vantatrace-ignore';

function isIgnored(path, state) {
  const tryStatementNode = path.parentPath.node;
  const bodyStatements = path.node.body.body;
  const searchStart = tryStatementNode.start;
  const searchEnd = bodyStatements.length > 0 ? bodyStatements[0].start : path.node.body.end;
  const comments = (state.file && state.file.ast && state.file.ast.comments) || [];
  return comments.some(
    (comment) =>
      comment.value.includes(IGNORE_DIRECTIVE) &&
      comment.start >= searchStart &&
      comment.end <= searchEnd
  );
}

// Detects a pre-existing `x.captureException(...)` or bare `captureExceptionGlobal(...)`
// call within this catch block's own synchronous flow. Does NOT descend into nested
// functions or nested catch clauses, so a manual capture inside an unrelated nested
// try/catch does not suppress injection in the outer block.
function alreadyManuallyCaptures(path, t) {
  let found = false;
  path.get('body').traverse({
    CallExpression(callPath) {
      const callee = callPath.node.callee;
      const isMemberCapture =
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property, { name: 'captureException' });
      const isBareGlobalCapture = t.isIdentifier(callee, { name: IMPORTED_FUNCTION_NAME });
      if (isMemberCapture || isBareGlobalCapture) {
        found = true;
        callPath.stop();
      }
    },
    Function(fnPath) {
      fnPath.skip();
    },
    CatchClause(nestedPath) {
      nestedPath.skip();
    }
  });
  return found;
}

function ensureEsmImport(path) {
  const identifier = addNamed(path, IMPORTED_FUNCTION_NAME, RUNTIME_IMPORT_SOURCE);
  return identifier.name;
}

function ensureCjsImport(programPath, state, t) {
  if (state.vantaTraceCjsLocalName) return state.vantaTraceCjsLocalName;

  const localId = programPath.scope.generateUidIdentifier('vantaTraceCapture');
  const requireDeclaration = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.objectPattern([
        t.objectProperty(t.identifier(IMPORTED_FUNCTION_NAME), t.identifier(localId.name), false, false)
      ]),
      t.callExpression(t.identifier('require'), [t.stringLiteral(RUNTIME_IMPORT_SOURCE)])
    )
  ]);

  programPath.unshiftContainer('body', requireDeclaration);
  state.vantaTraceCjsLocalName = localId.name;
  return localId.name;
}

module.exports = function ({ types: t }) {
  return {
    name: 'vantatrace-catch-injector',
    visitor: {
      CatchClause(path, state) {
        const param = path.node.param;

        // catch {} with no binding (ES2019 optional catch) - no error object to capture.
        if (!param) return;

        // catch ({ message }) / catch ([a, b]) - destructured binding. Skipped:
        // rewriting the destructure to recover the raw error risks colliding with
        // user code.
        if (!t.isIdentifier(param)) return;

        if (isIgnored(path, state)) return;
        if (alreadyManuallyCaptures(path, t)) return;

        const programPath = path.scope.getProgramParent().path;
        const isEsm = programPath.node.sourceType === 'module';
        const localName = isEsm
          ? ensureEsmImport(path)
          : ensureCjsImport(programPath, state, t);

        const captureCall = t.expressionStatement(
          t.callExpression(t.identifier(localName), [t.identifier(param.name)])
        );

        path.node.body.body.unshift(captureCall);
      }
    }
  };
};
