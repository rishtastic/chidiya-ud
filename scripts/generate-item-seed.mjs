import fs from 'node:fs'
import ts from 'typescript'

const result = []
for (const language of ['english', 'hindi']) {
  const source = fs.readFileSync(new URL(`../src/game/items/${language}.ts`, import.meta.url), 'utf8')
  const file = ts.createSourceFile(`${language}.ts`, source, ts.ScriptTarget.Latest, true)
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => item.name.getText(file) === `${language}Items`)
  if (!declaration || !ts.isArrayLiteralExpression(declaration.initializer)) {
    throw new Error(`Could not find ${language} items`)
  }
  for (const node of declaration.initializer.elements) {
    if (!ts.isObjectLiteralExpression(node)) throw new Error(`Invalid ${language} item`)
    const values = Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Invalid ${language} item property`)
      const key = property.name.getText(file)
      const value = property.initializer
      if (ts.isStringLiteral(value)) return [key, value.text]
      if (value.kind === ts.SyntaxKind.TrueKeyword) return [key, true]
      if (value.kind === ts.SyntaxKind.FalseKeyword) return [key, false]
      throw new Error(`Invalid ${language} item value`)
    }))
    result.push({ language, name: values.name, spoken: values.spoken, canFly: values.canFly })
  }
}
fs.writeFileSync(new URL('../internal/leaderboard/item_seed.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
