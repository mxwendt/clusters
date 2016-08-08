'use strict';

/**
 * PARSER
 *
 * Creates an abstract syntax tree using acorn.js from a piece of code
 * beautified using beautify.js.
 */

function Parser (codeText) {
  this.codeStr = this.beautify(codeText);
  this.ast = this.parseAST(this.codeStr);
  this.comments = [];
  this.annotations = [];

  this.parseComments(this.codeStr);
}

Parser.prototype.beautify = function (codeText) {
  return js_beautify(codeText);
};

Parser.prototype.parseAST = function (codeStr) {
  return acorn.parse(codeStr, {sourceType: "script", locations: true});
};

/**
 * Only @param annotations inside block comments get parsed. Each block comment can have multiple @param annotations.
 *
 * @param {String} codeStr
 * @returns {Array}
 */
Parser.prototype.parseComments = function (codeStr) {
  let self = this;

  // Line and block comments

  acorn.parse(codeStr, {
    sourceType: "script",
    locations: true,
    onComment: self.comments // collect comments in Esprima's format
  });

  // @param annotations

  let annotationNode = Object.create(null);
  annotationNode.params = [];

  for (let i = 0; i < this.comments.length; i++) {

    // Don't parse line comments
    if (this.comments[i].type === 'Line') continue;

    let lines = this.comments[i].value.split(/\r?\n/);

    // Don't parse block comments that are not tagged with @cluster
    let clusterTag = false;
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('* @cluster') > 0) {
        clusterTag = true;
      }
    }
    if (! clusterTag) continue;

    // Save the location of the block comment
    annotationNode.loc = this.comments[i].loc;

    // Save each @param annotation separately
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('* @param') > 0) {
        this.parseParamAnnotation(annotationNode, lines[j].substring(lines[j].indexOf('@')));
      }
    }

    this.annotations.push(annotationNode);
  }
};

Parser.prototype.parseParamAnnotation = function (annotationNode, line) {
  let fullParamName = line.substring(line.indexOf('}') + 1, line.indexOf('=')).trim(); // gets everything between '{' and '=', i.e. foo or foo.bar['baz']["qux"].quux

  if (splitObjNotation(fullParamName).length === 1) {
    this.createParamNode(annotationNode, line);
  } else {
    this.updateParamNode(annotationNode, line, splitObjNotation(fullParamName));
  }
};

Parser.prototype.createParamNode = function (annotationNode, line) {
  let newParamNode = Object.create(null);
  newParamNode.line = line;
  newParamNode.type = line.substring(line.indexOf('{') + 1, line.indexOf('}')); // gets everything between '{' and '}', either 'Boolean', 'Number', 'String', 'Array', or 'Object'
  newParamNode.name = line.substring(line.indexOf('}') + 1, line.indexOf('=')).trim(); // should be a base identifier like 'foo' without properties (not like 'foo.bar' or similar)

  let rawVals = line.substring(line.indexOf('=') + 1).trim();

  switch (newParamNode.type) {

    case 'Boolean': // @param {Boolean} foo = true
      newParamNode.init = Boolean(rawVals); // there is only one value
      annotationNode.params.push(newParamNode);

      break;

    case 'Number': // @param {Number} foo = 8, 0, 10
      let numVals = rawVals.split(', ');
      for (let i = 0; i < numVals.length; i++) {
        numVals[i] = Number(numVals[i]);
      }

      newParamNode.init = numVals[0];
      newParamNode.min = numVals[1];
      newParamNode.max = numVals[2];
      annotationNode.params.push(newParamNode);

      break;

    case 'String': // @param {String} foo = "blah-blah", "bluh-bluh", "blih-blih"
      let strVals = rawVals.split(', ');
      for (let j = 0; j < strVals.length; j++) {
        strVals[j] = eval(strVals[j]);
      }

      newParamNode.init = strVals[0]; // TODO: Allow for multiple variations of strings, see README
      annotationNode.params.push(newParamNode);

      break;

    case 'Array': // @param {Array} foo = [0, 1, 2, 3, 4, 5], [0, 2, 4, 6, 8, 10], [3, 2, 1]
      let arrVals = rawVals.split('], ');
      for (let m = 0; m < arrVals.length; m++) {
        arrVals[m] = eval(arrVals[m]);
      }

      newParamNode.init = arrVals[0]; // TODO: Allow for multiple variations of arrays, see README
      annotationNode.params.push(newParamNode);

      break;

    case 'Object': // @param {Object} foo = {}, null
      let objVals = rawVals.split(', ');
      for (let n = 0; n < objVals.length; n++) {
        if (objVals[n] === '{}') objVals[n] = {};
        else if (objVals[n] === 'null') objVals[n] = null;
        else if (objVals[n] === 'undefined') objVals[n] = undefined;
        else objVals[n] = eval(objVals[n]);
      }

      newParamNode.init = objVals[0]; // TODO: Allow for multiple variations of arrays, see README
      annotationNode.params.push(newParamNode);

      break;

    default:
      throw new Error('I don\'t know how to parse the @param annotation: ' + newParamNode.type);
  }

  // console.log(newParamNode);
};

Parser.prototype.updateParamNode = function (annotationNode, line, nameParts) {
  let existingParamNode;
  let newParamNodeName = nameParts.shift();
  let newParamNodeProp = Object.create(null);

  for (let i = 0; i < annotationNode.params.length; i++) {
    if (annotationNode.params[i].name === newParamNodeName) {
      existingParamNode = annotationNode.params[i];
    }
  }

  existingParamNode.line += '; ' + line;
  newParamNodeProp.type = line.substring(line.indexOf('{') + 1, line.indexOf('}')); // gets everything between '{' and '}', either 'Boolean', 'Number', 'String', 'Array', or 'Object'

  let rawVals = line.substring(line.indexOf('=') + 1).trim().split(', ');

  switch (newParamNodeProp.type) {

    case 'Boolean': // @param {Boolean} foo.bar = true
      rawVals[0] = Boolean(rawVals[0]); // there is only one value

      createNestedObj(existingParamNode.init, nameParts, rawVals[0]);

      break;

    case 'Number': // @param {Number} foo.bar = 8, 0, 10
      for (let i = 0; i < rawVals.length; i++) {
        rawVals[i] = Number(rawVals[i]);
      }

      createNestedObj(existingParamNode.init, nameParts, rawVals[0]);

      break;

    case 'String': // @param {String} foo = "blah-blah", "bluh-bluh", "blih-blih"
      for (let j = 0; j < rawVals.length; j++) {
        rawVals[j] = eval(rawVals[j]);
      }

      createNestedObj(existingParamNode.init, nameParts, rawVals[0]); // TODO: Allow for multiple variations of strings, see README

      break;

    case 'Array': // @param {Array} foo.bar = [0, 1, 2, 3, 4, 5], [0, 2, 4, 6, 8, 10], [3, 2, 1]
      for (let m = 0; m < rawVals.length; m++) {
        rawVals[m] = eval(rawVals[m]);
      }

      createNestedObj(existingParamNode.init, nameParts, rawVals[0]); // TODO: Allow for multiple variations of strings, see README

      break;

    case 'Object': // @param {Object} foo.bar = {}, null
      for (let n = 0; n < rawVals.length; n++) {
        if (rawVals[n] === '{}') rawVals[n] = {};
        else if (rawVals[n] === 'null') rawVals[n] = null;
        else if (rawVals[n] === 'undefined') rawVals[n] = undefined;
        else rawVals[n] = eval(rawVals[n]);
      }

      createNestedObj(existingParamNode.init, nameParts, rawVals[0]); // TODO: Allow for multiple variations of strings, see README

      break;

    default:
      throw new Error('I don\'t know how to parse the @param annotation: ' + newParamNode.type);
  }

  // console.log(existingParamNode);
};

Parser.prototype.getCodeStr = function () {
  return this.codeStr;
};

Parser.prototype.getAST = function () {
  return this.ast;
};

Parser.prototype.getAnnotations = function () {
  return this.annotations;
};

/**
 * WALKER
 *
 * Walks an abstract syntax tree and generates clusters with annotations.
 */

function Walker (parser, elem) {
  this.parser = parser;
  this.elem = elem;
  this.walk(this.parser.getAST(), this.parser.getAnnotations());
}

Walker.prototype.walk = function (ast, annotations) {
  let self = this;

  acorn.walk.recursive(ast, [this], {
    FunctionDeclaration: function (functionNode, state/*, c*/) { // i.e. function Foo () {} or function fooBar() {}
      let annotationNode = self.findAnnotation(annotations, functionNode.loc);
      if (annotationNode !== undefined) {
        state[0].cluster = new Cluster(functionNode, annotationNode);
        state[0].visualizer = new Visualizer(self.parser, self, self.elem);
      }
    },
    ExpressionStatement: function (functionNode, state/*, c*/) { // i.e. Foo.prototype.bar = function () {}
      let annotationNode = self.findAnnotation(annotations, functionNode.loc);
      if (annotationNode !== undefined) {
        state[0].cluster = new Cluster(functionNode.expression.right, annotationNode);
        state[0].visualizer = new Visualizer(self.parser, self, self.elem);
      }
    }
  });
};

Walker.prototype.findAnnotation = function (annotations, functionNodeLoc) {
  let annotationNode;

  for (var i = 0; i < annotations.length; i++) {
    if (annotations[i].loc.end.line + 1 === functionNodeLoc.start.line) {
      annotationNode = annotations[i];
    }
  }

  return annotationNode;
};

Walker.prototype.getCluster = function () {
  return this.cluster;
};

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
};

Environment.prototype.lookup = function (name) {
  var scope = this;
  while (scope) {
    if (Object.prototype.hasOwnProperty.call(scope.vars, name)) return scope;
    scope = scope.parent;
  }
};

Environment.prototype.get = function (name) {
  if (name in this.vars) return this.vars[name].value;
  throw new Error('Undefined variable: ' + name);
};

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

  throw new Error('Undefined variable: ' + name);
};

Environment.prototype.set = function (name, val, step) {
  var scope = this.lookup(name);

  // let's not allow defining globals from a nested environment
  if (!scope && this.parent) throw new Error('Undefined variable ' + name);

  (scope || this).vars[name].steps.push({step: step, value: this.format(val)});

  return (scope || this).vars[name].value = val;
};

Environment.prototype.def = function (name, val, step, propObj) {
  let valComp = val;
  let valStr = this.format(val);

  return this.vars[name] = {value: valComp, steps: [{step: step, value: valStr}], properties: propObj};
};

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
    retVal = '{';

    for (let prop in val) {
      retVal += prop + ': ' + this.format(val[prop]) + ', ';
    }

    if (! isObjectEmpty(val)) {
      retVal = retVal.slice(0, -2);
    }

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
};

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

  console.log(this.env);

  // TODO: move global variables to its own area in the state view
  // Set global variables
  // this.env.def('this', {}, 0);

  // Add params to the environment
  this.iterParams(functionDeclarationNode.params, annotationNode);

  // Go to each statement in the block
  this.iterBlockStatements(functionDeclarationNode.body);
}

Cluster.prototype.iterParams = function (paramsArray, annotationNode) {
  for (var i = 0; i < annotationNode.params.length; i++) {
    let paramObj = annotationNode.params[i];

    this.env.def(annotationNode.params[i].name, annotationNode.params[i].init, 0, paramObj);
  }
};

Cluster.prototype.iter = function (node) {
  switch (node.type) {

    case 'VariableDeclaration':
      this.execution.push({lineNum: node.loc.start.line, nodeType: 'VariableDeclaration'});

      for (var i = 0; i < node.declarations.length; i++) {
        this.evaluate(node.declarations[i], this.execution.length);
      }

      break;

    case 'IfStatement':


      if (this.evaluate(node.test, this.execution.length) === true) {
        this.execution.push({lineNum: node.loc.start.line, nodeType: 'IfStatement', val: true});
        this.iterBlockStatements(node.consequent);
      } else if (this.evaluate(node.test, this.execution.length) === false) {
        this.execution.push({lineNum: node.loc.start.line, nodeType: 'IfStatement', val: false});
        if (node.alternate !== null) {
          if (node.alternate.type === 'BlockStatement') {
            this.iterBlockStatements(node.alternate);
          } else {
            this.iter(node.alternate);
          }
        }
      }

      break;

    case 'WhileStatement':
      while (this.evaluate(node.test, this.execution.length + 1) === true) {
        this.execution.push({lineNum: node.loc.start.line, nodeType: 'WhileStatement', val: true});
        this.iterBlockStatements(node.body);
      }

      this.execution.push({lineNum: node.loc.start.line, nodeType: 'WhileStatement', val: false});

      break;

    case 'ForStatement':
      this.execution.push({lineNum: node.loc.start.line, nodeType: 'ForStatement'});

      for (var j = 0; j < node.init.declarations.length; j++) {
        this.evaluate(node.init.declarations[j], this.execution.length);
      }

      while (this.evaluate(node.test, this.execution.length) === true) {
        this.iterBlockStatements(node.body);
        this.evaluate(node.update, this.execution.length);
        this.execution.push({lineNum: node.loc.start.line, nodeType: 'ForStatement'});
      }

      break;

    case 'ExpressionStatement':
      this.execution.push({lineNum: node.loc.start.line, nodeType: 'ExpressionStatement'});

      this.evaluate(node.expression, this.execution.length);

      break;

    case 'ReturnStatement':
      this.execution.push({lineNum: node.loc.start.line, nodeType: 'ReturnStatement'});

      // the return statement is the only statement that changes the environment directly
      if (node.argument !== null) {
        if (node.argument.type === 'Identifier') {
          this.env.set(node.argument.name, this.evaluate(node.argument, this.execution.length), this.execution.length);
        } else if (node.argument.type === 'MemberExpression') {
          this.evaluate(node.argument);
        }
      }

      break;

    case 'ContinueStatement':
      this.execution.push({lineNum: node.loc.start.line, nodeType: 'ContinueStatement'});

      break;


    default:
      throw new Error('I don\'t know how to iterate ' + node.type);
  }
};

Cluster.prototype.iterBlockStatements = function (blockStatementsNode) {
  for (var i = 0; i < blockStatementsNode.body.length; i++) {
    this.iter(blockStatementsNode.body[i]);
  }
};

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

    case 'NewExpression':
      if (node.arguments.length === 0) { // {}
        return {};
      } else {
        if (node.callee.type === 'Identifier') {
          switch (node.callee.name) {
            case 'Array':
              if (node.arguments.length === 1 && typeof(this.evaluate(node.arguments[0])) === 'number') {
                // only one argument that is a number returns a new Array with length set to that number
                return new Array(this.evaluate(node.arguments[0]));
              }

              break;
            default:
              throw new Error('I don\'t know how to instantiate a new ' + node.callee.name);
          }
        }
      }

      break;

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
      let left = this.evaluate(node.left, step);
      let right = this.evaluate(node.right, step);

      try {
        return eval(left + node.operator + right);
      } catch (e) {
        if (e instanceof SyntaxError) {
          try {
            return eval('"' + left + '"' + node.operator + '"' + right + '"');
          } catch (e) {
            console.error(e);
          }
        } else {
          console.error(e);
        }
      }

      break;

    case 'AssignmentExpression':
      if (node.left.type === 'MemberExpression') {
        // TODO: Allow more than one level of nesting
        if (node.left.object.type === 'ThisExpression') {
          // for example: this.x = value
          let val = this.env.get('this', step);
          createNestedObj(val, [node.left.property.name], this.evaluate(node.right, step));
          return this.env.set('this', val, step);
        } else {
          // for example: variable.x = value
          let val = this.env.get(node.left.object.name, step) || {};
          createNestedObj(val, [node.left.property.name], this.evaluate(node.right, step));
          return this.env.set(node.left.object.name, val, step);
        }
      } else {
        return this.env.set(node.left.name, this.evaluate(node.right, step), step);
      }

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
};

Cluster.prototype.getExecution = function () {
  return this.execution;
};

Cluster.prototype.getEnv = function () {
  return this.env;
};

/**
 * VISUALIZER
 *
 * Visualizes the code using google-code-prettify.js and the code-specific
 * cluster using d3.js.
 */

function Visualizer (parser, walker, elem) {
  let self = this;

  this.parser = parser;
  this.walker = walker;
  this.elem = elem;
  this.codeStr = this.parser.getCodeStr();
  this.execution = this.walker.cluster.execution;
  this.env = this.walker.cluster.env;
  this.svg;

  this.ractive;
  this.ractiveData;
  this.ractiveTemplate;

  this.markupWrapper();
  this.markupCode(this.codeStr);
  this.calcWrapperWidths();
  this.visualizeExecution();
  this.markupState();

  this.ui = new UI(this);

  window.addEventListener('resize', function (e) {
    self.setDataWrapperW(self.calcDataWrapperW());
    self.setStateWrapperW(self.calcStateWrapperW());
  });
}

Visualizer.prototype.markupWrapper = function () {
  this.wrapper = document.createElement('div');
  this.wrapper.classList.add('cluster');

  this.codeWrapper = document.createElement('div');
  this.codeWrapper.classList.add('code');

  this.dataWrapper = document.createElement('div');
  this.dataWrapper.classList.add('data', 'is-hidden');

  this.stateWrapper = document.createElement('div');
  this.stateWrapper.classList.add('state', 'is-hidden');

  this.wrapper.appendChild(this.codeWrapper);
  this.wrapper.appendChild(this.dataWrapper);
  this.wrapper.appendChild(this.stateWrapper);

  this.elem.replaceChild(this.wrapper, this.elem.firstElementChild);
};

Visualizer.prototype.markupCode = function (codeStr) {
  // Pretty print the beautified code (theme copied from Stack Overflow)

  let pre = document.createElement('pre');
  pre.classList.add('default', 'linenums', 'prettyprint');

  let code = document.createElement('code');
  code.textContent = this.codeStr;

  pre.appendChild(code);

  this.codeWrapper.appendChild(pre);

  prettyPrint();
};

Visualizer.prototype.calcWrapperWidths = function () {
  this.setCodeWrapperW(this.calcCodeWrapperW() + 15);
  this.setDataWrapperW(this.calcDataWrapperW());
  this.setStateWrapperW(this.calcStateWrapperW());
};

Visualizer.prototype.markupState = function () {
  let self = this;

  // Template

  let paramsTemplate = '<div class="stateToggle icon-down-dir">Parameter</div><ol class="stateParams">';
  let valuesTemplate = '<div class="stateToggle icon-down-dir">State</div><ol class="stateValues">';

  for (let name in this.env.vars) {
    if (this.env.vars[name].properties !== undefined) {
      // parameter value
      if (this.env.vars[name].properties.type === 'Boolean') {
        // TODO: Evaluate if checked or not
        paramsTemplate += '<li>';
        paramsTemplate += '<span class="stateLabel">uses <span class="com">' + this.env.vars[name].properties.name + '</span>';
        paramsTemplate += '<input type="checkbox" checked="checked" value="{{state.params.' + this.env.vars[name].properties.name + '.val}}"></span>';
        paramsTemplate += '<span class="stateVal">{{{ beautify(state.params.' + this.env.vars[name].properties.name + '.val) }}}</span>';
        paramsTemplate += '</li>';
      } else if (this.env.vars[name].properties.type === 'Number') {
        paramsTemplate += '<li>';
        paramsTemplate += '<span class="stateLabel">uses <span class="com">' + this.env.vars[name].properties.name + '</span>';
        paramsTemplate += '<input type="range" min="' + this.env.vars[name].properties.min + '" max="' + this.env.vars[name].properties.max + '" value="{{state.params.' + this.env.vars[name].properties.name + '.val}}"></span>';
        paramsTemplate += '<span class="stateVal">{{{ beautify(state.params.' + this.env.vars[name].properties.name + '.val) }}}</span>';
        paramsTemplate += '</li>';
      } else if (this.env.vars[name].properties.type === 'String') {
        paramsTemplate += '<li>';
        paramsTemplate += '<span class="stateLabel">uses <span class="com">' + this.env.vars[name].properties.name + '</span>';
        paramsTemplate += '<select>';
        paramsTemplate += '<option value="{{ pure(state.params.' + this.env.vars[name].properties.name + '.val) }}" selected>Option 1</option>';
        paramsTemplate += '</select></span>';
        paramsTemplate += '<span class="stateVal">{{{ beautify(state.params.' + this.env.vars[name].properties.name + '.val) }}}</span>';
        paramsTemplate += '</li>';
      } else if (this.env.vars[name].properties.type === 'Array') {
        // TODO: Create inputs for array parameter => select
        paramsTemplate += '<li>';
        paramsTemplate += '<span class="stateLabel">uses <span class="com">' + this.env.vars[name].properties.name + '</span>';
        paramsTemplate += '<select>';
        paramsTemplate += '<option value="{{ pure(state.params.' + this.env.vars[name].properties.name + '.val) }}" selected>Option 1</option>';
        paramsTemplate += '</select></span>';
        paramsTemplate += '<span class="stateVal">{{{ beautify(state.params.' + this.env.vars[name].properties.name + '.val) }}}</span>';
        paramsTemplate += '</li>';
      } else if (this.env.vars[name].properties.type === 'Object') {
        // TODO: Create inputs for object parameter => depending on primitive type
        paramsTemplate += '<li>';
        paramsTemplate += '<span class="stateLabel">uses <span class="com">' + this.env.vars[name].properties.name + '</span></span>';
        paramsTemplate += '<span class="stateVal">{{{ beautify(state.params.' + this.env.vars[name].properties.name + '.val) }}}</span>';
        paramsTemplate += '</li>';
      }
    } else {
      if (Object.prototype.toString.call(this.env.vars[name].value) === '[object Boolean]') {
        valuesTemplate += '<li>';
        valuesTemplate += '<span class="stateLabel stateToggle icon-down-dir">sets ' + name + ' to</span>';
        valuesTemplate += '<span class="stateVal">{{{ beautify(state.values.' + name + '.val) }}}</span>';
        valuesTemplate += '</li>';
      } else if (Object.prototype.toString.call(this.env.vars[name].value) === '[object Number]') {
        valuesTemplate += '<li>';
        valuesTemplate += '<span class="stateLabel stateToggle icon-down-dir">sets ' + name + ' to</span>';
        valuesTemplate += '<span class="stateVal">{{{ beautify(state.values.' + name + '.val) }}}</span>';
        valuesTemplate += '</li>';
      } else if (Object.prototype.toString.call(this.env.vars[name].value) === '[object String]') {
        valuesTemplate += '<li>';
        valuesTemplate += '<span class="stateLabel stateToggle icon-down-dir">sets ' + name + ' to</span>';
        valuesTemplate += '<span class="stateVal">{{{ beautify(state.values.' + name + '.val) }}}</span>';
        valuesTemplate += '</li>';
      } else if (Object.prototype.toString.call(this.env.vars[name].value) === '[object Array]') {
        valuesTemplate += '<li>';
        valuesTemplate += '<span class="stateLabel stateToggle icon-down-dir">sets ' + name + ' to</span>';
        valuesTemplate += '<span class="stateVal">{{{ beautify(state.values.' + name + '.val) }}}</span>';
        valuesTemplate += '</li>';
      } else if (Object.prototype.toString.call(this.env.vars[name].value) === '[object Object]') {
        valuesTemplate += '<li>';
        valuesTemplate += '<span class="stateLabel stateToggle icon-down-dir">sets ' + name + ' to</span>';
        valuesTemplate += '<span class="stateVal">{{{ beautify(state.values.' + name + '.val) }}}</span>';
        valuesTemplate += '</li>';
      }
    }
  }

  paramsTemplate += '</ol>';
  valuesTemplate += '</ol>';

  this.ractiveTemplate = paramsTemplate + valuesTemplate;

  // Data

  this.ractiveData = Object.create(null);
  this.ractiveData.params = Object.create(null);
  this.ractiveData.values = Object.create(null);

  for (let name in this.env.vars) {
    if (this.env.vars[name].properties !== undefined) {
      // param data
      this.ractiveData.params[name] = Object.create(null);
      this.ractiveData.params[name].val = this.env.getAtStep(name, 1); // Using 1 gets the initial value
    } else {
      // value data
      this.ractiveData.values[name] = Object.create(null);
      this.ractiveData.values[name].val = this.env.getAtStep(name, 1); // Using 1 gets the initial value
    }
  }

  // Ractive

  this.ractive = new Ractive({
    el: self.stateWrapper,
    template: self.ractiveTemplate,
    data: {
      state: self.ractiveData,
      raw: function (val) {
        if (val !== undefined) return val;
      },
      beautify: function (val) {
        if (val !== undefined) return self.parser.beautify(val);
      },
      pure: function (val) {
        if (val !== undefined && typeof(val) === 'string') return val.substring(1, val.length - 1);
      }
    }
  });
};

Visualizer.prototype.visualizeExecution = function () {
  let self = this;

  this.svg = d3.select(this.dataWrapper)
    .append('svg')
      .attr('width', 0)
      .attr('height', this.getH())
      .style('background-image', 'repeating-linear-gradient(180deg, rgba(248, 248, 248, 0.6), rgba(248, 248, 248, 0.6) ' +
        self.getLineH() + 'px, rgba(255, 255, 255, 0.6) ' + self.getLineH() + 'px, rgba(255, 255, 255, 0.6) ' + (self.getLineH() * 2) + 'px)');

  this.xAxis = this.svg.append("g")
    .attr("class", "axis");

  this.svg.attr('width', this.getW());

  let x = d3.scale.ordinal().domain(d3.range(this.execution.length + 2)).rangePoints([0, (this.getExecution().length + 2) * 10]);
  let y = d3.scale.ordinal().domain(d3.range(this.getLineCount())).rangePoints([0, (this.getLineCount() - 1) * this.getLineH()]);

  // JOIN new data with old elements
  this.dots = this.svg.selectAll('.dot')
      .data(this.execution);

  // EXIT old elements not present in new data
  this.dots.exit().remove();

  // UPDATE old elements present in new data
  this.dots.attr('cx', function(d, i) { return x(i + 1); })
    .attr('cy', function(d, i) { return y(d.lineNum) - Math.ceil(self.getLineH() / 2); });

  // ENTER new elements present in new data
  this.dots.enter().append('circle')
    .attr('class', function(d, i) { return 'dot' + ' ' + d.lineNum + ' ' + d.nodeType + ' ' + d.val; })
    .attr('cx', function(d, i) { return x(i + 1); })
    .attr('cy', function(d, i) { return y(d.lineNum) - Math.ceil(self.getLineH() / 2); })
    .attr('r', 3);

  this.dots.on('mouseover', function() {
    if (! this.classList.contains('is-active')) {
      // this.setAttribute('stroke', '#EC5E5D');
    }
  }).on('mouseout', function() {
    if (! this.classList.contains('is-active')) {
      // this.setAttribute('stroke', '#FFFFFF');
    }
  }).on('click', function(d, i) {
    if (! this.classList.contains('is-active')) {
      self.ui.getExecSlider().value = i;
      self.ui.getExecSlider().dispatchEvent(new Event('input'));
    }
  });

  this.axis = d3.svg.axis()
    .scale(x)
    .orient('top');

  this.xAxis.call(this.axis);
};

Visualizer.prototype.getW = function () {
  return (this.execution.length + 2) * 10;
};

Visualizer.prototype.getH = function () {
  return this.getLineCount() * this.getLineH();
};

Visualizer.prototype.getLineH = function () {
  return this.codeWrapper.querySelector('ol.linenums').children[0].clientHeight;
};

Visualizer.prototype.calcCodeWrapperW = function () {
  let lineElems = this.codeWrapper.querySelectorAll('ol.linenums > li');
  let w = 500; // minimum width of code that allows for a good display of all possible annotations

  for (var i = 0; i < lineElems.length; i++) {
    if (! lineElems[i].querySelector('code > .com')) {
      let codeElemW = lineElems[i].querySelector('code').clientWidth;
      if (codeElemW > w) {
        w = codeElemW;
      }
    }
  }

  return Math.floor(w);
};

Visualizer.prototype.calcDataWrapperW = function () {
  if (this.codeWrapperW === undefined) this.codeWrapperW = this.calcCodeWrapperW();

  let dataAndStateW = this.wrapper.clientWidth - this.codeWrapperW;
  let percW = 0.5;

  return Math.floor(dataAndStateW * percW);
};

Visualizer.prototype.calcStateWrapperW = function () {
  if (this.codeWrapperW === undefined) this.codeWrapperW = this.calcCodeWrapperW();

  let dataAndStateW = this.wrapper.clientWidth - this.codeWrapperW;
  let percW = 0.5;

  return Math.floor(dataAndStateW * percW);
};

Visualizer.prototype.setCodeWrapperW = function (w) {
  this.codeWrapperW = w;
  this.codeWrapper.style.maxWidth = this.codeWrapperW + 'px';
};

Visualizer.prototype.setDataWrapperW = function (w) {
  this.dataWrapperW = w;
  this.dataWrapper.style.maxWidth = this.dataWrapperW + 'px';
};

Visualizer.prototype.setStateWrapperW = function (w) {
  this.stateWrapperW = w;
  this.stateWrapper.style.maxWidth = this.stateWrapperW + 'px';
};

Visualizer.prototype.getLineCount = function () {
  return this.codeWrapper.querySelector('ol.linenums').children.length;
};

Visualizer.prototype.getWrapper = function () {
  return this.wrapper;
};

Visualizer.prototype.getDataWrapper = function () {
  return this.dataWrapper;
};

Visualizer.prototype.getCodeWrapper = function () {
  return this.codeWrapper;
};

Visualizer.prototype.getExecution = function () {
  return this.execution;
};

Visualizer.prototype.getDots = function () {
  return this.dots;
};

Visualizer.prototype.getRactive = function () {
  return this.ractive;
};

Visualizer.prototype.getEnvironment = function () {
  return this.env;
};

/**
 * UI
 */

function UI (visualizer) {
  this.vis = visualizer;
  this.lastStep = 1;

  this.addToggleButton();
  this.addExecutionSlider();
  this.addResizeHandle();
}

UI.prototype.addToggleButton = function () {
  // Add the toggle button for the graphical supplements

  let vis = this.vis;

  this.wrapperToggle = document.createElement('div');
  this.wrapperToggle.classList.add('wrapperToggle', 'icon-right-dir');
  this.wrapperToggle.addEventListener('click', function (e) {
    e.target.classList.toggle('icon-right-dir');
    e.target.classList.toggle('icon-left-dir');
    vis.wrapper.classList.toggle('is-active');
    vis.dataWrapper.classList.toggle('is-hidden');
    vis.stateWrapper.classList.toggle('is-hidden');
  });

  this.vis.codeWrapper.querySelector('ol.linenums').firstElementChild.appendChild(this.wrapperToggle);
};

UI.prototype.addExecutionSlider = function () {
  this.execSlider = document.createElement('input');
  this.execSlider.type = "range";
  this.execSlider.min = 0;
  this.execSlider.max = this.vis.execution.length - 1;
  this.execSlider.value = 0;
  this.execSlider.classList.add('execSlider');
  this.execSlider.style.width = this.vis.getW() - 6 + 'px';

  if (this.vis.execution.length <= 1) this.execSlider.style.display = 'none';

  this.execSlider.addEventListener('input', this.onExecutionSliderInput.bind(this), false);

  this.vis.dataWrapper.appendChild(this.execSlider);

  // show position of execution

  this.vis.stepLine = this.vis.xAxis.append('rect')
    .attr('class', 'stepLine')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', 0)
    .attr('height', this.vis.getH());

  this.highlightLine();
  this.updateStepLine();

  this.addStateToggles();
};

UI.prototype.addResizeHandle = function () {
  let self = this;

  this.resizeHandle = document.createElement('div');
  this.resizeHandle.classList.add('resizeHandle');

  this.isResizing = false;

  this.resizeHandle.addEventListener('mousedown', function (e) {
    self.isResizing = true;
    self.lastDownX = e.clientX;
    console.log("mousedown");
  });

  this.vis.getWrapper().addEventListener('mousemove', function (e) {
    if (! self.isResizing) return false; // return if we don't resize

    console.log("mousemove");
  });

  this.vis.getWrapper().addEventListener('mouseup', function (e) {
    self.isResizing = false;
    console.log("mouseup");
  });

  // Hide the resize handle if all data is visible

  window.addEventListener('resize', function (e) {
    if (self.vis.dataWrapperW >= self.vis.getW()) {
      self.resizeHandle.classList.add('is-hidden');
    } else {
      self.resizeHandle.classList.remove('is-hidden');
    }
  });

  this.vis.getDataWrapper().appendChild(this.resizeHandle);
};

UI.prototype.highlightLine = function () {
  this.unhighlightLine();

  let step = this.execSlider !== undefined ? this.execSlider.value : 0;
  let line = this.vis.codeWrapper.querySelector('ol.linenums').children[this.vis.execution[step].lineNum - 1];

  line.classList.add('is-highlighted');
};

UI.prototype.unhighlightLine = function () {
  let lines = this.vis.codeWrapper.querySelector('ol.linenums').children;

  for (var i = 0; i < lines.length; i++) {
    if (lines[i].classList.contains('is-highlighted')) {
      lines[i].classList.remove('is-highlighted');
    }
  }
};

UI.prototype.updateStepLine = function () {
  let ticks = this.vis.xAxis.selectAll('.tick');

  for (let j = 0; j < ticks[0].length; j++) {
    if (j == this.execSlider.value) {
      let transformAttr = ticks[0][j + 1].getAttribute('transform');
      this.vis.stepLine.attr('width', transformAttr.substring(transformAttr.indexOf('(') + 1, transformAttr.indexOf(',')));
    }
  }
};

UI.prototype.updateState = function () {
  let step = Number(this.execSlider.value) + 1;

  for (let param in this.vis.ractive.get().state.values) {
    // if (this.vis.ractive.values.hasOwnProperty(value)) {}
    this.vis.ractive.set('state.values.' + param + '.val', this.vis.env.getAtStep(param, step));
  }

  for (let value in this.vis.ractive.get().state.values) {
    // if (this.vis.ractive.values.hasOwnProperty(value)) {}
    let promise = this.vis.ractive.set('state.values.' + value + '.val', this.vis.env.getAtStep(value, step));
  }
};

UI.prototype.onExecutionSliderInput = function (e) {
  e.stopPropagation();

  this.highlightLine();
  this.updateStepLine();
  this.updateState();
};

UI.prototype.getExecSlider = function () {
  return this.execSlider;
};

UI.prototype.addStateToggles = function () {
  let stateToggleElems = this.vis.wrapper.querySelectorAll('.stateToggle');

  for (let i = 0; i < stateToggleElems.length; i++) {
    stateToggleElems[i].addEventListener('click', function (e) {
      e.target.classList.toggle('icon-down-dir');
      e.target.classList.toggle('icon-right-dir');
      e.target.nextElementSibling.classList.toggle('is-hidden');
    });
  }
};


/**
 * Utils
 */

function isObjectEmpty (obj) {
  for(var key in obj) {
    if(obj.hasOwnProperty(key)){
      return false;
    }
  }
  return true;
}

function splitObjNotation (objNotation) {
  let notationParts = objNotation.split(/[\[\]"'.]+/);

  // Remove the last item if the parameter name ends on a bracket notation because then it is an empty string, i.e. foo.["bar"] or foo.['baz']
  if (notationParts[notationParts.length - 1] === "") notationParts.pop();

  return notationParts;
}

function createNestedObj (base, propNames, value) {
  let lastPropName = arguments.length === 3 ? propNames.pop() : false;

  for (let i = 0; i < propNames.length; i++) {
    base = base[propNames[i]] = base[propNames[i]] || {};
  }

  if (lastPropName) base = base[lastPropName] = value;

  return base;
}

function matrixToArray(str) {
  return str.match(/(-?[0-9\.]+)/g);
}

//! INIT .......................................................................

// Get the code as a string
// TODO: Make it work for more than one <pre> element
// TODO: Make it work when code comes in string format, i.e from a JSON file
var codeElem = document.querySelectorAll('.snippet');

for (var i = 0; i < codeElem.length; i++) {
  let parser = new Parser(codeElem[i].textContent);
  let walker = new Walker(parser, codeElem[i]);
}
