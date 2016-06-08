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
  if (name in this.vars) return this.vars[name].value;
  throw new Error('Undefined variable ' + name);
}

Environment.prototype.getAtStep = function (name, step) {
  if (name in this.vars) {
    let retVal;
    let steps = this.vars[name].steps;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].step <= step) {
        retVal = steps[i].value;
      }
    }
    return retVal;
  }

  throw new Error('Undefined variable ' + name);
}

Environment.prototype.set = function (name, val, step) {
   var scope = this.lookup(name);

   // let's not allow defining globals from a nested environment
   if (!scope && this.parent) throw new Error('Undefined variable ' + name);

   let newVal = (scope || this).vars[name].value = val;

   (scope || this).vars[name].steps.push({step: step, value:  val.toString()});

   return newVal;
}

Environment.prototype.def = function (name, val, step) {
  let valComp = val;
  let valStr = val !== null ? val.toString() : 'undefined';

  return this.vars[name] = {value: valComp, steps: [{step: step, value: valStr}]};
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
  this.env.def(functionDeclarationNode.params[0].name, 8, 0);
  // this.env.def(functionDeclarationNode.params[0].name, "searchengine=http://www.google.com/search?q=$1\n" +
  //           "spitefulness=9.7\n" +
  //           "\n" +
  //           "; comments are preceded by a semicolon...\n" +
  //           "; each section concerns an individual enemy\n" +
  //           "[larry]\n" +
  //           "fullname=Larry Doe\n" +
  //           "type=kindergarten bully\n" +
  //           "website=http://www.geocities.com/CapeCanaveral/11451\n" +
  //           "\n" +
  //           "[gargamel]\n" +
  //           "fullname=Gargamel\n" +
  //           "type=evil sorcerer\n" +
  //           "outputdir=/home/marijn/enemies/gargamel", 0);

  // Go to each statement in the block
  this.iterBlockStatements(functionDeclarationNode.body);
}

Cluster.prototype.iter = function (node) {
  switch (node.type) {

    case 'VariableDeclaration':
      this.execution.push(node.loc.start.line);

      for (var i = 0; i < node.declarations.length; i++) {
        let name = node.declarations[i].id.name;
        let val = node.declarations[i].init === null ? null : this.evaluate(node.declarations[i].init, this.execution.length);
        this.env.def(name, val, this.execution.length);
      }

      break;

    case 'IfStatement':
      this.execution.push(node.loc.start.line);

      if (this.evaluate(node.test) == true) {
        this.iterBlockStatements(node.consequent);
      } else if (this.evaluate(node.test) == false) {
        if (node.alternate !== null) {
          this.iter(node.alternate);
        }
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

    case 'ForStatement':
      for (var j = 0; j < node.init.declarations.length; j++) {
        let name = node.init.declarations[j].id.name;
        let val = node.init.declarations[j].init === null ? null : this.evaluate(node.init.declarations[j].init, this.execution.length);
        this.env.def(name, val, this.execution.length);
      }

      while (this.evaluate(node.test) === true) {
        this.execution.push(node.loc.start.line);
        this.iterBlockStatements(node.body);
        this.evaluate(node.update, this.execution.length);
      }

      this.execution.push(node.loc.start.line);

      break;

    case 'ExpressionStatement':
      this.execution.push(node.loc.start.line);

      this.evaluate(node.expression, this.execution.length);

      break;

    case 'ReturnStatement':
      this.execution.push(node.loc.start.line);

      if (node.argument !== null) {
        let nodeName = node.argument.name;
        this.env.set(nodeName, this.env.get(nodeName), this.execution.length);
      }

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

Cluster.prototype.evaluate = function (node, step) {
  switch (node.type) {

    case 'Literal':
      return node.value;

    case 'Identifier':
      return this.env.get(node.name);

    case 'ArrayExpression':
      let array = [];

      for (var i = 0; i < node.elements.length; i++) {
        array.push(this.evaluate(node.elements[i], step));
      }

      return array;

    case 'ObjectExpression':
      let obj = {};

      for (var j = 0; j < node.properties.length; j++) {
        if (node.properties[j].kind === 'init') {
          obj[node.properties[j].key.name] = this.evaluate(node.properties[j].value, step);
        }
      }

      return obj;

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

      this.env.set(node.argument.name, updateExprVal, step);

      return retVal;

    case 'BinaryExpression':
      let left = this.evaluate(node.left, step).toString();
      let right = this.evaluate(node.right, step).toString();
      let binaryExpr = left + node.operator + right;

      return eval(binaryExpr);

    case 'AssignmentExpression':
      return this.env.set(node.left.name, this.evaluate(node.right, step), step);

    case 'MemberExpression':
      if (node.computed === true) {
        return this.evaluate(node.object)[this.evaluate(node.property, step)];
      } else if (node.computed === false) {
        return this.evaluate(node.object, step)[node.property.name];
      }

      break;

    case 'CallExpression':
      if (node.callee.computed === true) { // computed (a[b]) member expression, property is an 'Expression'
        // TODO: Implement computed expression
      } else if (node.callee.computed === false) { // static (a.b) member expression, property is an 'Identifier'
        let callExprObj = this.evaluate(node.callee.object, step);
        let callExprProp = node.callee.property.name;
        let callExprParams = this.evaluate(node.arguments[0], step); // TODO: Allow more than one argument
        let retVal = callExprObj[callExprProp](callExprParams);

        if (Object.prototype.toString.call(callExprObj) === '[object Array]') {
          this.env.set(node.callee.object.name, callExprObj, step);
        }

        return retVal;
      }

      break;

    default:
      throw new Error('I don\'t know how to evaluate ' + node.type);
  }
}

Cluster.prototype.getExecution = function () {
  return this.execution;
}

Cluster.prototype.getEnv = function () {
  return this.env;
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
  this.env = walker.getCluster().getEnv();

  this.markupWrapper();
  this.markupCode(this.codeStr);
  this.visualizeExecution();
  this.markupState();

  this.ui = new UI(this);
}

Visualizer.prototype.markupWrapper = function () {
  this.wrapper = document.createElement('div');
  this.wrapper.classList.add('snippet');

  this.codeWrapper = document.createElement('div');
  this.codeWrapper.classList.add('code');

  this.dataWrapper = document.createElement('div');
  this.dataWrapper.classList.add('data');

  this.stateWrapper = document.createElement('div');
  this.stateWrapper.classList.add('state');

  this.wrapper.appendChild(this.codeWrapper);
  this.wrapper.appendChild(this.dataWrapper);
  this.wrapper.appendChild(this.stateWrapper);

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

Visualizer.prototype.markupState = function () {
  let params = document.createElement('ol');
  params.classList.add('stateParams');

  let item = document.createElement('li');
  item.textContent = 'uses size 8';

  params.appendChild(item);

  this.stateWrapper.appendChild(params);

  let self = this;

  this.ractive = new Ractive({
    el: self.stateWrapper,
    template:
      '<ol class="stateParams">' +
        '<li>uses size <span class="stateVal">{{ params.size.val }}</span></li>' +
      '</ol>' +
      '<ol class="stateValues">' +
        '<li>sets first to <span class="stateVal">{{ values.first.val }}</span></li>' +
        '<li>sets second to <span class="stateVal">{{ values.second.val }}</span></li>' +
        '<li>sets next to <span class="stateVal">{{ values.next.val }}</span></li>' +
        '<li>sets count to <span class="stateVal">{{ values.count.val }}</span></li>' +
        '<li>sets result to <span class="stateVal">{{ values.result.val }}</span></li>' +
      '</ol>' +
      '<ol class="stateReturns">' +
        '<li>returns <span class="stateVal">{{ returns.result.val }}</span></li>' +
      '</ol>',
    data: {
      params: {
        size: {
          val: self.env.getAtStep('size', 1) // Using 1 gets the initial value
        }
      },
      values: {
        first: {
          val: self.env.getAtStep('first', 1)
        },
        second: {
          val: self.env.getAtStep('second', 1)
        },
        next: {
          val: self.env.getAtStep('next', 1)
        },
        count: {
          val: self.env.getAtStep('count', 1)
        },
        result: {
          val: self.env.getAtStep('result', 1)
        }
      },
      returns: {
        result: {
          val: self.env.getAtStep('result', 1)
        }
      }
    }
  });
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

Visualizer.prototype.getRactive = function () {
  return this.ractive;
}

Visualizer.prototype.getEnvironment = function () {
  return this.env;
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

UI.prototype.updateState = function () {
  let ractive = this.vis.getRactive();
  let env = this.vis.getEnvironment();
  let step = Number(this.execSlider.value) + 1;

  for (var value in ractive.get().values) {
    // if (ractive.values.hasOwnProperty(value)) {}
    ractive.set('values.' + value + '.val', env.getAtStep(value, step));
  }

  if (step === this.vis.getExecution().length) {
    for (var retVal in ractive.get().returns) {
      // if (ractive.values.hasOwnProperty(value)) {}
      ractive.set('returns.' + retVal + '.val', env.getAtStep(retVal, step));
    }
  } else {
    for (var retVal in ractive.get().returns) {
      // if (ractive.values.hasOwnProperty(value)) {}
      ractive.set('returns.' + retVal + '.val', '');
    }
  }
}

UI.prototype.onExecutionSliderInput = function (e) {
  e.stopPropagation();

  this.highlightLine();
  this.highlightDot();
  this.updateState();
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
