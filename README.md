# clusters

„I tried to picture clusters of information as they move through the computer.
What do they look like? The state. The execution. The behavior. I kept dreaming
of a world I thought I’d never see. And then, one day … I visualized it.“

http://lisperator.net/pltut/
http://eloquentjavascript.net/11_language.html
http://www.compilers.iecc.com/crenshaw/

# Setup workspace

run 'http-server' on the command line

# Rules of annotation

The rules extend the rules of annotating functions defined by the JSDoc markup
language (http://usejsdoc.org/).

Boolean value
* {type, initial value}
* value is a `boolean`
* editable as checkbox

```javascript
/**
 * @param {Boolean, true} foo
 */
function fubar(foo) {}
```

Number value
* {type, initial value, min value, max value}
* value is a `number`
* editable as range input

```javascript
/**
 * @param {Number, 8, 0, 10} foo
 */
function fubar(foo) {}
```

String value
* {type, initial value [, optional alternative values]}
* value is a `string`
* editable as select dropdown

```javascript
/**
 * @param {String, "blah-blah", "bluh-bluh", "blih-blih"} foo
 */
function fubar(foo) {}
```

Array value
* {type, initial value [, optional alternative values]}
* value is an `array`
* editable as select dropdown

```javascript
/**
 * @param {Array, [0, 1, 2, 3, 4, 5], [0, 2, 4, 6, 8, 10], [3, 2, 1]} foo
 */
function fubar(foo) {}
```

Object values
* editable according to type

```javascript
/**
 * @param {Number, 8, 0, 10} foo.bar
 * @param {String, ”blah-blah“} foo.baz
 * @param {Boolean, true} foo.thud
 * @param {Array, [0, 1, 2, 3, 4,5]} foo.qux
 *
 * Nested:
 * @param {Number, 8, 0, 10} foo.plugh.bar
 */
function fubar(foo) {}
```

The values are all editable by default.

The naming of the variables in the object values only annotate values that are
needed for the function to work, not the whole object. The values are made up of
the other values.
