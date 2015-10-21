"use strict";

let Expression = require('./expression.js');

class Lookup extends Expression {
  constructor(parsed, env) {
    super(parsed, env);
    let makeExpression = require('./factory.js');
    this.parent = makeExpression(parsed.parent, this.env);
  }
  // TODO: evaluate() looks up parsed.child
}

module.exports = Lookup;

