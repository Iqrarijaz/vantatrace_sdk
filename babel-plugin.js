module.exports = function ({ types: t }) {
  return {
    name: 'vantatrace-catch-injector',
    visitor: {
      CatchClause(path) {
        const param = path.node.param;
        // catch {} with no binding — skip
        if (!param) return;

        // Check for vantatrace-ignore directive in comments
        // We check leading comments on the CatchClause or its parent TryStatement
        const comments = [
          ...(path.node.leadingComments || []),
          ...(path.node.body.innerComments || []),
          ...(path.parent.leadingComments || [])
        ];
        
        const shouldIgnore = comments.some(c => c.value.includes('vantatrace-ignore'));
        if (shouldIgnore) return;

        // Ensure vantaTrace.captureException isn't already called
        let alreadyCaptures = false;
        path.traverse({
          CallExpression(callPath) {
            const callee = callPath.node.callee;
            if (
              t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property, { name: 'captureException' }) &&
              t.isIdentifier(callee.object, { name: 'vantaTrace' })
            ) {
              alreadyCaptures = true;
              callPath.stop();
            }
          }
        });

        if (alreadyCaptures) return;

        // Inject: vantaTrace.captureException(param)
        const captureCall = t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('vantaTrace'), t.identifier('captureException')),
            [t.identifier(param.name)]
          )
        );

        path.node.body.body.unshift(captureCall);
      }
    }
  };
};
