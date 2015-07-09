// **ShExWriter** writes ShEx documents.

// Matches a literal as represented in memory by the ShEx library
var ShExLiteralMatcher = /^"([^]*)"(?:\^\^(.+)|@([\-a-z]+))?$/i;

// rdf:type predicate (for 'a' abbreviation)
var RDF_PREFIX = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    RDF_TYPE   = RDF_PREFIX + 'type';

// Characters in literals that require escaping
var escape    = /["\\\t\n\r\b\f\u0000-\u0019\ud800-\udbff]/,
    escapeAll = /["\\\t\n\r\b\f\u0000-\u0019]|[\ud800-\udbff][\udc00-\udfff]/g,
    escapeReplacements = { '\\': '\\\\', '"': '\\"', '\t': '\\t',
                           '\n': '\\n', '\r': '\\r', '\b': '\\b', '\f': '\\f' };

// ## Constructor
function ShExWriter(outputStream, options) {
  if (!(this instanceof ShExWriter))
    return new ShExWriter(outputStream, options);

  // Shift arguments if the first argument is not a stream
  if (outputStream && typeof outputStream.write !== 'function')
    options = outputStream, outputStream = null;
  options = options || {};

  // If no output stream given, send the output as string through the end callback
  if (!outputStream) {
    var output = '';
    this._outputStream = {
      write: function (chunk, encoding, done) { output += chunk; done && done(); },
      end:   function (done) { done && done(null, output); },
    };
    this._endStream = true;
  }
  else {
    this._outputStream = outputStream;
    this._endStream = options.end === undefined ? true : !!options.end;
  }

  // Initialize writer, depending on the format
  this._prefixIRIs = Object.create(null);
  options.prefixes && this.addPrefixes(options.prefixes);

  this._error = options.error || _throwError;

  this._expect = options.lax ? noop : expect;
}

ShExWriter.prototype = {
  // ## Private methods

  // ### `_write` writes the argument to the output stream
  _write: function (string, callback) {
    this._outputStream.write(string, 'utf8', callback);
  },

    // ### `_writeShape` writes the shape to the output stream
  _writeShape: function (shape, done) {
    var _ShExWriter = this;
    try {
      // Don't repeat the subject if it's the same
      var pieces = []; // guessing push/join is faster than concat
      this._expect(shape, 'type', 'shape');

      if (shape.virtual) pieces.push("VIRTUAL ");
      if (shape.closed) pieces.push("CLOSED ");

      if (shape.inherit && shape.inherit.length > 0) {
	pieces.push("&");
	shape.inherit.forEach(function (i, ord) {
	  pieces.push(_ShExWriter._encodeShapeName(i, ord > 0));
	});
	pieces.push(" ");
      }

      if (shape.extra && shape.extra.length > 0) {
	pieces.push("EXTRA");
	shape.extra.forEach(function (i, ord) {
	  pieces.push(_ShExWriter._encodeShapeName(i, ord > 0));
	});
	pieces.push(" ");
      }
      pieces.push("{\n");

      function _writeSemActs (semActs) {
	if (!semActs)
	  return;

	Object.keys(semActs).forEach(function (k) {
	  pieces.push(" %",
		      _ShExWriter._encodePredicate(k),
		      "{"+semActs[k]+"%"+"}");
	});
      }

      function _writeCardinality (min, max) {
	if      (min === 0 && max === 1)         pieces.push("?");
	else if (min === 0 && max === undefined) pieces.push("*");
	else if (min === 1 && max === 1)                         ;
	else if (min === 1 && max === undefined) pieces.push("+");
	else
	  pieces.push("{", min, ",", (max === undefined ? "*" : max), "}");
      }

      function _writeExpression (expr, indent, precedent) {
	if (expr.type === 'tripleConstraint') {
	  pieces.push(indent,
		      _ShExWriter._encodePredicate(expr.predicate),
		      " ");
	  var v = expr.value;
	  expect(v, 'type', 'valueClass');
	  if (!v.reference && !v.nodeKind && !v.values)
	    pieces.push(". ");
	  else {
	    var nodeKinds = {
	      'iri': "IRI",
	      'bnode': "BNODE",
	      'literal': "LITERAL",
	      'nonliteral': "NONLITERAL"
	    };
	    if (v.nodeKind in nodeKinds)       pieces.push(nodeKinds[v.nodeKind], " ");
	    else if (v.nodeKind !== undefined) _ShExWriter._error("unexpected nodeKind: " + v.nodeKind);

	    if (v.reference && v.values) _ShExWriter._error("found both reference and values in "+expr);
	    if (v.reference && v.datatype) _ShExWriter._error("found both reference and datatype in "+expr);
	    if (v.datatype && v.values) _ShExWriter._error("found both datatype and values in "+expr);

	    if (v.reference) {
	      pieces.push("&");
	      try { // !! How do i distinguish an object from a string?
		pieces.push(v.conjuncts.map(function (c) {
		  return _ShExWriter._encodeShapeName(c);
		}).join(" OR "));
	      } catch (e) {
		pieces.push(_ShExWriter._encodeShapeName(v.reference));
	      }
	    }

	    if (v.values) {
	      pieces.push("(");

	      v.values.forEach(function (t, ord) {
		if (ord > 1)
		  pieces.push(" ");

		try { // !! How do i distinguish an object from a string?
		  // expect(v, 'type', 'stemRange');
		  pieces.push(_ShExWriter._encodeValue(t.stem));
		  t.exclusions.forEach(function (c) {
		    pieces.push(" - "+_ShExWriter._encodeShapeName(c));
		  });
		} catch (e) {
		  pieces.push(_ShExWriter._encodeValue(t));
		}
	      });

	      pieces.push(")");
	    }
	  }

	  if ('pattern' in v)
	    pieces.push("~", _ShExWriter._encodeValue(v.pattern), " ");
	  ['length', 'minlength', 'maxlength',
	   'mininclusive', 'minexclusive', 'maxinclusive', 'maxexclusive',
	   'totaldigits', 'fractiondigits'
	  ].forEach(function (a) {
	    if (v[a])
	      pieces.push(a, " ", v[a]);
	  });
	}
	else if (expr.type === 'group') {
	}
      }

      _writeExpression(shape.expression, "  ", 4);
      pieces.push("}");
      _writeSemActs(shape.semAct);
      pieces.push("\n");

      this._write(pieces.join(''), done);

    }
    catch (error) { done && done(error); }
  },

  // ### `_encodeIriOrBlankNode` represents an IRI or blank node
  _encodeIriOrBlankNode: function (iri, trailingSpace) {
    trailingSpace = trailingSpace ? ' ' : '';
    // A blank node is represented as-is
    if (iri[0] === '_' && iri[1] === ':') return iri;
    // Escape special characters
    if (escape.test(iri))
      iri = iri.replace(escapeAll, characterReplacer);
    // Try to represent the IRI as prefixed name
    var prefixMatch = this._prefixRegex.exec(iri);
    return !prefixMatch ? '<' + iri + '>' :
           (!prefixMatch[1] ? iri : this._prefixIRIs[prefixMatch[1]] + prefixMatch[2]) + trailingSpace;
  },

  // ### `_encodeLiteral` represents a literal
  _encodeLiteral: function (value, type, language) {
    // Escape special characters
    if (escape.test(value))
      value = value.replace(escapeAll, characterReplacer);
    // Write the literal, possibly with type or language
    if (language)
      return '"' + value + '"@' + language;
    else if (type)
      return '"' + value + '"^^' + this._encodeIriOrBlankNode(type);
    else
      return '"' + value + '"';
  },

  // ### `_encodeShapeName` represents a subject
  _encodeShapeName: function (subject, trailingSpace) {
    if (subject[0] === '"')
      throw new Error('A literal as subject is not allowed: ' + subject);
    return this._encodeIriOrBlankNode(subject, trailingSpace);
  },

  // ### `_encodePredicate` represents a predicate
  _encodePredicate: function (predicate) {
    if (predicate[0] === '"')
      throw new Error('A literal as predicate is not allowed: ' + predicate);
    return predicate === RDF_TYPE ? 'a' : this._encodeIriOrBlankNode(predicate);
  },

  // ### `_encodeValue` represents an object
  _encodeValue: function (object) {
    // Represent an IRI or blank node
    if (object[0] !== '"')
      return this._encodeIriOrBlankNode(object);
    // Represent a literal
    var match = ShExLiteralMatcher.exec(object);
    if (!match) throw new Error('Invalid literal: ' + object);
    return this._encodeLiteral(match[1], match[2], match[3]);
  },

  // ### `_blockedWrite` replaces `_write` after the writer has been closed
  _blockedWrite: function () {
    throw new Error('Cannot write because the writer has been closed.');
  },

  // ### `addShape` adds the shape to the output stream
  addShape: function (shape, done) {
    this._writeShape(shape, done);
  },

  // ### `addShapes` adds the shapes to the output stream
  addShapes: function (shapes) {
    for (var i = 0; i < shapes.length; i++)
      this.addShape(shapes[i]);
  },

  // ### `addPrefix` adds the prefix to the output stream
  addPrefix: function (prefix, iri, done) {
    var prefixes = {};
    prefixes[prefix] = iri;
    this.addPrefixes(prefixes, done);
  },

  // ### `addPrefixes` adds the prefixes to the output stream
  addPrefixes: function (prefixes, done) {
    // Add all useful prefixes
    var prefixIRIs = this._prefixIRIs, hasPrefixes = false;
    for (var prefix in prefixes) {
      // Verify whether the prefix can be used and does not exist yet
      var iri = prefixes[prefix];
      if (/[#\/]$/.test(iri) && prefixIRIs[iri] !== (prefix += ':')) {
        hasPrefixes = true;
        prefixIRIs[iri] = prefix;
        // Write prefix
        this._write('@prefix ' + prefix + ' <' + iri + '>.\n');
      }
    }
    // Recreate the prefix matcher
    if (hasPrefixes) {
      var IRIlist = '', prefixList = '';
      for (var prefixIRI in prefixIRIs) {
        IRIlist += IRIlist ? '|' + prefixIRI : prefixIRI;
        prefixList += (prefixList ? '|' : '') + prefixIRIs[prefixIRI];
      }
      IRIlist = IRIlist.replace(/[\]\/\(\)\*\+\?\.\\\$]/g, '\\$&');
      this._prefixRegex = new RegExp('^(?:' + prefixList + ')[^\/]*$|' +
                                     '^(' + IRIlist + ')([a-zA-Z][\\-_a-zA-Z0-9]*)$');
    }
    // End a prefix block with a newline
    this._write(hasPrefixes ? '\n' : '', done);
  },

  // ### `_prefixRegex` matches a prefixed name or IRI that begins with one of the added prefixes
  _prefixRegex: /$0^/,

  // ### `end` signals the end of the output stream
  end: function (done) {
    // Disallow further writing
    this._write = this._blockedWrite;

    // Try to end the underlying stream, ensuring done is called exactly one time
    var singleDone = done && function (error, result) { singleDone = null, done(error, result); };
    if (this._endStream) {
      try { return this._outputStream.end(singleDone); }
      catch (error) { /* error closing stream */ }
    }
    singleDone && singleDone();
  },
};

// Replaces a character by its escaped version
function characterReplacer(character) {
  // Replace a single character by its escaped version
  var result = escapeReplacements[character];
  if (result === undefined) {
    // Replace a single character with its 4-bit unicode escape sequence
    if (character.length === 1) {
      result = character.charCodeAt(0).toString(16);
      result = '\\u0000'.substr(0, 6 - result.length) + result;
    }
    // Replace a surrogate pair with its 8-bit unicode escape sequence
    else {
      result = ((character.charCodeAt(0) - 0xD800) * 0x400 +
                 character.charCodeAt(1) + 0x2400).toString(16);
      result = '\\U00000000'.substr(0, 10 - result.length) + result;
    }
  }
  return result;
}

function _throwError (str) {
  throw new Error(str);
}

// Expect property p with value v in object o
function expect (o, p, v) {
  if (!(p in o))
    this._error("expected "+o+" to have a ."+p);
  if (arguments.length > 2 && o[p] !== v)
    this._error("expected "+o[o]+" to equal ."+v);
}

// The empty function
function noop () {}

// ## Exports

// Export the `ShExWriter` class as a whole.
if (typeof require !== 'undefined' && typeof exports !== 'undefined')
  module.exports = ShExWriter; // node environment