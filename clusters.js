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
  this.ast = this.parseAST(this.codeStr);
  this.annotations = this.parseComments(this.codeStr);
}

Parser.prototype.beautify = function (codeText) {
  return js_beautify(codeText);
}

Parser.prototype.parseAST = function (codeStr) {
  return acorn.parse(codeStr, {sourceType: "script", locations: true});
}

Parser.prototype.parseComments = function (codeStr) {
  let comments = [];

  acorn.parse(codeStr, {
    sourceType: "script",
    locations: true,
    onComment: comments // collect comments in Esprima's format
  });

  return this.parseAnnotations(comments);
}

Parser.prototype.parseAnnotations = function (comments) {
  let annotations = [];

  for (let i = 0; i < comments.length; i++) {

    // Copy the location of the full comment (multiple lines in case of block comment)
    let annotationNode = Object.create(null);
    annotationNode.loc = comments[i].loc;
    annotationNode.params = [];

    // Parse for @param annotations
    let lines = comments[i].value.split(/\r?\n/);

    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('@param') > 0) {
        let paramNode = Object.create(null);
        let paramName = lines[j].substring(lines[j].indexOf('} ') + 2);
        let paramVals = lines[j].substring(lines[j].indexOf('{') + 1, lines[j].indexOf('}')).split(', ');

        paramNode.name = paramName;
        paramNode.type = paramVals[0];

        if (paramVals[0] === "Number") {
          paramNode.init = Number(paramVals[1]);
          paramNode.min = Number(paramVals[2]);
          paramNode.max = Number(paramVals[3]);
        } else if (paramVals[0] === "String") {
          paramNode.init = eval(paramVals[1]);
        }

        annotationNode.params.push(paramNode);
      }
    }

    annotations.push(annotationNode);
  }

  return annotations;
}

Parser.prototype.getCodeStr = function () {
  return this.codeStr;
}

Parser.prototype.getAST = function () {
  return this.ast;
}

Parser.prototype.getAnnotations = function () {
  return this.annotations;
}

/**
 * WALKER
 *
 * Walks an abstract syntax tree and generates clusters with annotations.
 */

function Walker (parser) {
  this.walk(parser.getAST(), parser.getAnnotations());
}

Walker.prototype.walk = function (ast, annotations) {
  let self = this;

  acorn.walk.recursive(ast, [this], {
    FunctionDeclaration: function (functionNode, state/*, c*/) {
      let annotationNode = self.findAnnotation(annotations, functionNode.loc);

      state[0].cluster = new Cluster(functionNode, annotationNode);
    }
  });
}

Walker.prototype.findAnnotation = function (annotations, functionNodeLoc) {
  let annotationNode;

  for (var i = 0; i < annotations.length; i++) {
    if (annotations[i].loc.end.line + 1 === functionNodeLoc.start.line) {
      annotationNode = annotations[i];
    }
  }

  return annotationNode;
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

   (scope || this).vars[name].steps.push({step: step, value: this.format(val)});

   return (scope || this).vars[name].value = val;;
}

Environment.prototype.def = function (name, val, step, type) {
  let valComp = val;
  let valStr = this.format(val);

  return this.vars[name] = {value: valComp, steps: [{step: step, value: valStr}], type: type};
}

Environment.prototype.format = function (val) {
  let retVal;

  if (Object.prototype.toString.call(val) === '[object Array]') {
    // format array
    retVal = '[';
    if (val.length > 0) {
      for (var i = 0; i < val.length; i++) {
        retVal += this.format(val[i]) + ', ';
      }
      retVal = retVal.slice(0, -2);
    }
    retVal += ']';
  } else if (Object.prototype.toString.call(val) === '[object Object]') {
    // format object
    retVal = '{'
    for (var prop in val) {
      retVal += prop + ': ' + this.format(val[prop]) + ', ';
    }
    retVal = retVal.slice(0, -2);
    retVal += '}';
  } else if (Object.prototype.toString.call(val) === '[object String]') {
    // format string
    retVal = '"' + val + '"';
  } else if (val === null) {
    // format null
    retVal = 'null';
  } else if (val === undefined) {
    // format undefined
    retVal = 'undefined';
  } else {
    // fallback
    retVal = val.toString();
  }

  return retVal;
}

/**
 * CLUSTER
 *
 * A cluster is code-specific data from analyzing 'function declaration', i.e.
 * control flow, ...
 *
 * TODO: Enable more than only 'function declarations'
 */

function Cluster (functionDeclarationNode, annotationNode) {
  this.env = new Environment();
  this.execution = [];

  // Add params to the environment
  this.iterParams(functionDeclarationNode.params, annotationNode);

  // Go to each statement in the block
  this.iterBlockStatements(functionDeclarationNode.body);
}

Cluster.prototype.iterParams = function (paramsArray, annotationNode) {
  // TODO: Make params dynamic
  // @param {Number} size [0, 10] = 8

  for (var i = 0; i < annotationNode.params.length; i++) {
    this.env.def(annotationNode.params[i].name, annotationNode.params[i].init, 0, "param");
  }
}

Cluster.prototype.iter = function (node) {
  switch (node.type) {

    case 'VariableDeclaration':
      this.execution.push(node.loc.start.line);

      for (var i = 0; i < node.declarations.length; i++) {
        this.evaluate(node.declarations[i], this.execution.length);
      }

      break;

    case 'IfStatement':
      this.execution.push(node.loc.start.line);

      if (this.evaluate(node.test, this.execution.length) === true) {
        this.iterBlockStatements(node.consequent);
      } else if (this.evaluate(node.test, this.execution.length) === false) {
        if (node.alternate !== null) {
          this.iter(node.alternate);
        }
      }

      break;

    case 'WhileStatement':
      this.execution.push(node.loc.start.line);

      while (this.evaluate(node.test, this.execution.length + 1) === true) {
        this.iterBlockStatements(node.body);
        this.execution.push(node.loc.start.line);
      }

      break;

    case 'ForStatement':
      this.execution.push(node.loc.start.line);

      for (var j = 0; j < node.init.declarations.length; j++) {
        this.evaluate(node.init.declarations[j], this.execution.length);
      }

      while (this.evaluate(node.test, this.execution.length) === true) {
        this.iterBlockStatements(node.body);
        this.evaluate(node.update, this.execution.length);
        this.execution.push(node.loc.start.line);
      }

      break;

    case 'ExpressionStatement':
      this.execution.push(node.loc.start.line);

      this.evaluate(node.expression, this.execution.length);

      break;

    case 'ReturnStatement':
      this.execution.push(node.loc.start.line);

      // the return statement is the only statement that changes the environment directly
      if (node.argument !== null) {
        this.env.set(node.argument.name, this.evaluate(node.argument, this.execution.length), this.execution.length);
      }

      break;

    case 'ContinueStatement':
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

Cluster.prototype.evaluate = function (node, step) {
  switch (node.type) {

    case 'Literal':
      return node.value;

    case 'Identifier':
      return this.env.get(node.name);

    case 'VariableDeclarator':
      let varName = node.id.name;
      let varVal = node.init === null ? undefined : this.evaluate(node.init, step);
      this.env.def(varName, varVal, step);

      return undefined; // because JS also returns undefined

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
          ++step;
        }
        else if (node.operator === '--') {
          retVal = updateExprVal--;
          --step;
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
        // computed (a[b]) member expression, property is an 'Expression'
        return this.evaluate(node.object)[this.evaluate(node.property, step)];
      } else if (node.computed === false) {
        // static (a.b) member expression, property is an 'Identifier'
        return this.evaluate(node.object, step)[node.property.name];
      }

      break;

    case 'CallExpression':
      if (node.callee.computed === true) {
        // computed (a[b]) member expression, property is an 'Expression'
        // TODO: Implement computed expression
      } else if (node.callee.computed === false) {
        // static (a.b) member expression, property is an 'Identifier'
        let callExprObj = this.evaluate(node.callee.object, step);
        let callExprProp = node.callee.property.name;
        let callExprParams = this.evaluate(node.arguments[0], step); // TODO: Allow more than one argument
        let retVal = callExprObj[callExprProp](callExprParams);

        if (Object.prototype.toString.call(callExprObj) === '[object Array]') {
          if (node.callee.object.type === 'Identifier') {
            // top level method i.e. a.push
            this.env.set(node.callee.object.name, this.env.get(node.callee.object.name), step);
          } else if (node.callee.object.type === 'MemberExpression') {
            // first level method i.e. a.b.push
            this.env.set(node.callee.object.object.name, this.env.get(node.callee.object.object.name), step);
          }
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
  let self = this;

  // Template

  let paramsTemplate = '<ol class="stateParams">';
  let valuesTemplate = '<ol class="stateValues">';

  for (let name in this.env.vars) {
    if (this.env.vars[name].type === 'param') {
      paramsTemplate += '<li>' + name + '{{{ raw(state.params.' + name + '.val) }}}</li>';
    } else {
      valuesTemplate += '<li>' + name + '{{{ beautify(state.values.' + name + '.val) }}}</li>';
    }
  }

  paramsTemplate += '</ol>';
  valuesTemplate += '</ol>';

  let ractiveTemplate = paramsTemplate + valuesTemplate;

  // Data

  let ractiveData = Object.create(null);

  ractiveData.params = Object.create(null);
  ractiveData.values = Object.create(null);

  for (let name in this.env.vars) {
    if (this.env.vars[name].type === 'param') {
      ractiveData.params[name] = Object.create(null);
      ractiveData.params[name].val = this.env.getAtStep(name, 1) // Using 1 gets the initial value
    } else {
      ractiveData.values[name] = Object.create(null);
      ractiveData.values[name].val = this.env.getAtStep(name, 1) // Using 1 gets the initial value
    }
  }

  // Ractive

  this.ractive = new Ractive({
    el: self.stateWrapper,
    template: ractiveTemplate,
    data: {
      state: ractiveData,
      raw: function (val) {
        if (val !== undefined) return ' = <span class="stateVal">' + val + '</span>';
      },
      beautify: function (val) {
        if (val !== undefined) return ' = <span class="stateVal">' + parser.beautify(val) + '</span>';
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

  for (let param in ractive.get().state.values) {
    // if (ractive.values.hasOwnProperty(value)) {}
    ractive.set('state.values.' + param + '.val', env.getAtStep(param, step));
  }

  for (let value in ractive.get().state.values) {
    // if (ractive.values.hasOwnProperty(value)) {}
    ractive.set('state.values.' + value + '.val', env.getAtStep(value, step));
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
