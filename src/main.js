'use strict';

console.log("INIT");

/**
 * PARSER
 *
 * Creates an abstract syntax tree using acorn.js from a piece of code
 * beautified using beautify.js.
 */

function Parser (codeText) {
  this.codeStr = this.beautify(codeText);
  this.ast = this.parse(this.codeStr);
}

Parser.prototype.beautify = function (codeText) {
  return js_beautify(codeText);
}

Parser.prototype.parse = function (codeStr) {
  return acorn.parse(codeStr, {sourceType: "script", locations: true});
}

Parser.prototype.getCodeStr = function () {
  return this.codeStr;
}

Parser.prototype.getAST = function () {
  return this.ast;
}

/**
 * WALKER
 *
 * Walks an abstract syntax tree and generates clusters.
 */

function Walker (parser) {
  this.walk(parser.getAST());
}

Walker.prototype.walk = function (ast) {
  acorn.walk.recursive(ast, [this], {
    FunctionDeclaration: function(node, state/*, c*/) {
      state[0].cluster = new Cluster(node);
    }
  });
}

Walker.prototype.getCluster = function () {
  return this.cluster;
}

/**
 * ENVIRONMENT
 *
 * The key to correct execution is to properly maintain the environment - a
 * structure holding variable bindings.
 */

function Environment (parent) {
  this.vars = Object.create(parent ? parent.vars : null);
  this.parent = parent;
}

Environment.prototype.extend = function () {
  return new Environment(this);
}

Environment.prototype.lookup = function (name) {
  var scope = this;
  while (scope) {
    if (Object.prototype.hasOwnProperty.call(scope.vars, name)) return scope;
    scope = scope.parent;
  }
}

Environment.prototype.get = function (name) {
  if (name in this.vars) return this.vars[name];
  throw new Error('Undefined variable ' + name);
}

Environment.prototype.set = function (name, val) {
   var scope = this.lookup(name);

   // let's not allow defining globals from a nested environment
   if (!scope && this.parent) throw new Error('Undefined variable ' + name);

   return (scope || this).vars[name] = val;
}

Environment.prototype.def = function (name, val) {
  return this.vars[name] = val;
}

/**
 * CLUSTER
 *
 * A cluster is code-specific data from analyzing 'function declaration', i.e.
 * control flow, ...
 *
 * TODO: Enable more than only 'function declarations'
 */

function Cluster (functionDeclarationNode) {
  this.env = new Environment();
  this.execution = [];

  // Add params to the environment
  // TODO: Make params dynamic
  this.env.def(functionDeclarationNode.params[0].name, 8);

  // Go to each statement in the block
  this.iterBlockStatements(functionDeclarationNode.body);
}

Cluster.prototype.iter = function (node) {
  switch (node.type) {

    case 'VariableDeclaration':
      this.execution.push(node.loc.start.line);

      for (var i = 0; i < node.declarations.length; i++) {
        let name = node.declarations[i].id.name;
        let val = node.declarations[i].init === null ? null : this.evaluate(node.declarations[i].init);
        this.env.def(name, val);
      }

      break;

    case 'IfStatement':
      this.execution.push(node.loc.start.line);

      if (this.evaluate(node.test) === true) {
        this.iterBlockStatements(node.consequent);
      }

      // TODO: Implement ELSE consequent

      break;

    case 'WhileStatement':
      while (this.evaluate(node.test) === true) {
        this.execution.push(node.loc.start.line);
        this.iterBlockStatements(node.body);
      }

      this.execution.push(node.loc.start.line);

      break;

    case 'ExpressionStatement':
      this.execution.push(node.loc.start.line);

      this.evaluate(node.expression);

      break;

    case 'ReturnStatement':
      this.execution.push(node.loc.start.line);

      break;

    default:
      throw new Error('I don\'t know how to iterate ' + node.type);
  }
}

Cluster.prototype.iterBlockStatements = function (blockStatementsNode) {
  for (var i = 0; i < blockStatementsNode.body.length; i++) {
    this.iter(blockStatementsNode.body[i]);
  }
}

Cluster.prototype.evaluate = function (node) {
  switch (node.type) {

    case 'Literal':
      return node.value;

    case 'Identifier':
      return this.env.get(node.name);

    case 'ArrayExpression':
      let array = [];

      for (var i = 0; i < node.elements.length; i++) {
        array.push(this.evaluate(node.elements[i]));
      }

      return array;

    case 'UpdateExpression':
      let updateExprVal = this.env.get(node.argument.name);
      let retVal;

      if (node.prefix === true) {
        if (node.operator === '++') {
          retVal = ++updateExprVal;
        } else if (node.operator === '--') {
          retVal = --updateExprVal;
        }
      }

      if (node.prefix === false) {
        if (node.operator === '++') {
          retVal = updateExprVal++;
        }
        else if (node.operator === '--') {
          retVal = updateExprVal--;
        }
      }

      this.env.set(node.argument.name, updateExprVal);

      return retVal;

    case 'BinaryExpression':
      let left = this.evaluate(node.left).toString();
      let right = this.evaluate(node.right).toString();
      let binaryExpr = left + node.operator + right;

      return eval(binaryExpr);

    case 'AssignmentExpression':
      return this.env.set(node.left.name, this.evaluate(node.right));

    case 'CallExpression':
      if (node.callee.computed === true) { // computed (a[b]) member expression, property is an 'Expression'
        // TODO: Implement computed expression
      } else if (node.callee.computed === false) { // static (a.b) member expression, property is an 'Identifier'
        let callExprObj = this.env.get(node.callee.object.name);
        let callExprProp = node.callee.property.name;
        let callExprParams = this.env.get(node.arguments[0].name); // TODO: Allow more than one argument

        return callExprObj[callExprProp](callExprParams);
      }

      break;

    default:
      throw new Error('I don\'t know how to evaluate ' + node.type);
  }
}

Cluster.prototype.getExecution = function () {
  return this.execution;
}

/**
 * VISUALIZER
 *
 * Visualizes the code using google-code-prettify.js and the code-specific
 * cluster using d3.js.
 */

function Visualizer (parser, walker) {
  this.codeStr = parser.getCodeStr();
  this.execution = walker.getCluster().getExecution();

  this.markupWrapper();
  this.markupCode(this.codeStr);
  this.visualizeExecution();

  this.ui = new UI(this);
}

Visualizer.prototype.markupWrapper = function () {
  this.wrapper = document.createElement('div');
  this.wrapper.classList.add('snippet');

  this.codeWrapper = document.createElement('div');
  this.codeWrapper.classList.add('code');

  this.dataWrapper = document.createElement('div');
  this.dataWrapper.classList.add('data');

  this.wrapper.appendChild(this.codeWrapper);
  this.wrapper.appendChild(this.dataWrapper);

  document.querySelector('body').appendChild(this.wrapper);
}

Visualizer.prototype.markupCode = function (codeStr) {
  let pre = document.createElement('pre');
  pre.classList.add('default', 'linenums', 'prettyprint');

  let code = document.createElement('code');
  code.textContent = this.codeStr;

  pre.appendChild(code);

  this.codeWrapper.appendChild(pre);

  // Pretty print the beautified code (theme copied from Stack Overflow)
  prettyPrint();
}

Visualizer.prototype.visualizeExecution = function () {
  let self = this;

  let svg = d3.select(this.dataWrapper)
    .append('svg')
      .attr('width', 0)
      .attr('height', this.getH())
      .style('background-image', 'repeating-linear-gradient(180deg, rgba(248, 248, 248, 0.6), rgba(248, 248, 248, 0.6) ' +
        (this.getH() / this.getLineCount()) + 'px, rgba(255, 255, 255, 0.6) ' + (this.getH() / this.getLineCount()) + 'px, rgba(255, 255, 255, 0.6) ' + (this.getH() / this.getLineCount() * 2) + 'px)');

  let xAxis = svg.append("g")
    .attr("class", "axis");

  svg.attr('width', this.getW());

  let x = d3.scale.ordinal().domain(d3.range(this.execution.length + 2)).rangePoints([0, this.getW()]);
  let y = d3.scale.ordinal().domain(d3.range(this.getLineCount() + 1)).rangePoints([0, this.getH()]);

  // JOIN new data with old elements
  this.dots = svg.selectAll('.dot')
      .data(this.execution);

  // EXIT old elements not present in new data
  this.dots.exit().remove();

  // UPDATE old elements present in new data
  this.dots.attr('cx', function(d, i) { return x(i + 1); })
      .attr('cy', function(d, i) { return y(d - 1) + (self.getH() / self.getLineCount() / 2); });

  // ENTER new elements present in new data
  this.dots.enter().append('circle')
      .attr('class', function(d, i) { return 'dot' + ' ' + d; })
      .attr('cx', function(d, i) { return x(i + 1); })
      .attr('cy', function(d, i) { return y(d - 1) + (self.getH() / self.getLineCount() / 2); })
      .attr('r', 4);

  this.dots.on('mouseover', function() {
    if (! this.classList.contains('is-active')) {
      this.setAttribute('stroke', '#EC5E5D');
    }
  }).on('mouseout', function() {
    if (! this.classList.contains('is-active')) {
      this.setAttribute('stroke', '#FFFFFF');
    }
  }).on('click', function(d, i) {
    if (! this.classList.contains('is-active')) {
      self.ui.getExecSlider().value = i;
      self.ui.getExecSlider().dispatchEvent(new Event('input'));
    }
  });

  let axis = d3.svg.axis()
    .scale(x)
    .orient('top');

  xAxis.call(axis);
}

Visualizer.prototype.getW = function () {
  return (this.execution.length + 2) * 10;
}

Visualizer.prototype.getH = function () {
  return this.codeWrapper.clientHeight;
}

Visualizer.prototype.getLineCount = function () {
  return this.codeWrapper.querySelector('ol.linenums').children.length;
}

Visualizer.prototype.getDataWrapper = function () {
  return this.dataWrapper;
}

Visualizer.prototype.getCodeWrapper = function () {
  return this.codeWrapper;
}

Visualizer.prototype.getExecution = function () {
  return this.execution;
}

Visualizer.prototype.getDots = function () {
  return this.dots;
}

/**
 * UI
 */

function UI (visualizer) {
  this.vis = visualizer;

  this.addExecutionSlider();
}

UI.prototype.addExecutionSlider = function () {
  this.execSlider = document.createElement('input');
  this.execSlider.type = "range";
  this.execSlider.min = 0;
  this.execSlider.max = this.vis.getExecution().length - 1;
  this.execSlider.value = 0;
  this.execSlider.classList.add('execSlider');
  this.execSlider.style.width = this.vis.getW() - 6 + 'px';

  if (this.vis.getExecution().length <= 1) this.execSlider.style.display = 'none';

  this.execSlider.addEventListener('input', this.onExecutionSliderInput.bind(this), false);

  this.vis.getDataWrapper().appendChild(this.execSlider);

  this.highlightLine();
  this.highlightDot();
}

UI.prototype.highlightLine = function () {
  this.unhighlightLine();

  let step = this.execSlider !== undefined ? this.execSlider.value : 0;
  let line = this.vis.getCodeWrapper().querySelector('ol.linenums').children[this.vis.getExecution()[step] - 1];

  line.classList.add('is-highlighted');
}

UI.prototype.unhighlightLine = function () {
  let lines = this.vis.getCodeWrapper().querySelector('ol.linenums').children;

  for (var i = 0; i < lines.length; i++) {
    if (lines[i].classList.contains('is-highlighted')) {
      lines[i].classList.remove('is-highlighted');
    }
  }
}

UI.prototype.highlightDot = function () {
  let self = this;

  this.unhighlightDot();

  this.vis.getDots().each(function(d, i) {
    if (i == self.execSlider.value) {
      this.classList.add('is-active');
    }
  });
}

UI.prototype.unhighlightDot = function () {
  this.vis.getDots().each(function(d, i) {
    if (this.classList.contains('is-active')) {
      this.classList.remove('is-active');
    }
  });
}

UI.prototype.onExecutionSliderInput = function (e) {
  e.stopPropagation();

  this.highlightLine();
  this.highlightDot();
}

UI.prototype.getExecSlider = function () {
  return this.execSlider;
}

//! INIT .......................................................................

// Get the code as a string
// TODO: Make it work for more than one <pre> element
// TODO: Make it work when code comes in string format, i.e from a JSON file
var codeElem = document.getElementsByTagName('pre');
var codeText = codeElem[0].textContent;

// Remove elements from the DOM
for (var i = 0; i < codeElem.length; i++) {
  codeElem[i].remove();
}

var parser = new Parser(codeText);
var walker = new Walker(parser);
var visualizer = new Visualizer(parser, walker);
