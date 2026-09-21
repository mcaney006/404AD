//#region \0vite/modulepreload-polyfill.js
(function polyfill() {
	const relList = document.createElement("link").relList;
	if (relList && relList.supports && relList.supports("modulepreload")) return;
	for (const link of document.querySelectorAll("link[rel=\"modulepreload\"]")) processPreload(link);
	new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") continue;
			for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
		}
	}).observe(document, {
		childList: true,
		subtree: true
	});
	function getFetchOpts(link) {
		const fetchOpts = {};
		if (link.integrity) fetchOpts.integrity = link.integrity;
		if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
		if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
		else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
		else fetchOpts.credentials = "same-origin";
		return fetchOpts;
	}
	function processPreload(link) {
		if (link.ep) return;
		link.ep = true;
		const fetchOpts = getFetchOpts(link);
		fetch(link.href, fetchOpts);
	}
})();
//#endregion
//#region ../../node_modules/.bun/preact@10.29.8/node_modules/preact/dist/preact.module.js
var n$1;
var l$3;
var u$3;
var t$2;
var i$3;
var r$2;
var o$2;
var e$2;
var f$3;
var c$2;
var a$2;
var s$2;
var h$3;
var p$3;
var v$2;
var d$2 = {};
var w$3 = [];
var _$2 = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
var g$2 = Array.isArray;
function m$2(n, l) {
	for (var u in l) n[u] = l[u];
	return n;
}
function b$2(n) {
	n && n.parentNode && n.parentNode.removeChild(n);
}
function k$1(l, u, t) {
	var i, r, o, e = {};
	for (o in u) "key" == o ? i = u[o] : "ref" == o ? r = u[o] : e[o] = u[o];
	if (arguments.length > 2 && (e.children = arguments.length > 3 ? n$1.call(arguments, 2) : t), "function" == typeof l && null != l.defaultProps) for (o in l.defaultProps) void 0 === e[o] && (e[o] = l.defaultProps[o]);
	return x$2(l, e, i, r, null);
}
function x$2(n, t, i, r, o) {
	var e = {
		type: n,
		props: t,
		key: i,
		ref: r,
		__k: null,
		__: null,
		__b: 0,
		__e: null,
		__c: null,
		constructor: void 0,
		__v: null == o ? ++u$3 : o,
		__i: -1,
		__u: 0
	};
	return null == o && null != l$3.vnode && l$3.vnode(e), e;
}
function S$1(n) {
	return n.children;
}
function C$1(n, l) {
	this.props = n, this.context = l;
}
function $(n, l) {
	if (null == l) return n.__ ? $(n.__, n.__i + 1) : null;
	for (var u; l < n.__k.length; l++) if (null != (u = n.__k[l]) && null != u.__e) return u.__e;
	return "function" == typeof n.type ? $(n) : null;
}
function I(n) {
	if (n.__P && n.__d) {
		var u = n.__v, t = u.__e, i = [], r = [], o = m$2({}, u);
		o.__v = u.__v + 1, l$3.vnode && l$3.vnode(o), q$1(n.__P, o, u, n.__n, n.__P.namespaceURI, 32 & u.__u ? [t] : null, i, null == t ? $(u) : t, !!(32 & u.__u), r), o.__v = u.__v, o.__.__k[o.__i] = o, D(i, o, r), u.__e = u.__ = null, o.__e != t && P(o);
	}
}
function P(n) {
	if (null != (n = n.__) && null != n.__c) return n.__e = n.__c.base = null, n.__k.some(function(l) {
		if (null != l && null != l.__e) return n.__e = n.__c.base = l.__e;
	}), P(n);
}
function A(n) {
	(!n.__d && (n.__d = !0) && i$3.push(n) && !H.__r++ || r$2 != l$3.debounceRendering) && ((r$2 = l$3.debounceRendering) || o$2)(H);
}
function H() {
	try {
		for (var n, l = 1; i$3.length;) i$3.length > l && i$3.sort(e$2), n = i$3.shift(), l = i$3.length, I(n);
	} finally {
		i$3.length = H.__r = 0;
	}
}
function L(n, l, u, t, i, r, o, e, f, c, a) {
	var s, h, p, v, y, _, g = t && t.__k || w$3, m = l.length;
	for (f = T$1(u, l, g, f, m), s = 0; s < m; s++) null != (p = u.__k[s]) && (h = -1 != p.__i && g[p.__i] || d$2, p.__i = s, _ = q$1(n, p, h, i, r, o, e, f, c, a), v = p.__e, p.ref && h.ref != p.ref && (h.ref && J(h.ref, null, p), a.push(p.ref, p.__c || v, p)), null == y && null != v && (y = v), 4 & p.__u ? (f = j$2(p, f, n), h.__e && (h.__e = null)) : "function" == typeof p.type && void 0 !== _ ? f = _ : v && (f = v.nextSibling), p.__u &= -7);
	return u.__e = y, f;
}
function T$1(n, l, u, t, i) {
	var r, o, e, f, c, a = u.length, s = a, h = 0;
	for (n.__k = new Array(i), r = 0; r < i; r++) null != (o = l[r]) && "boolean" != typeof o && "function" != typeof o ? ("string" == typeof o || "number" == typeof o || "bigint" == typeof o || o.constructor == String ? o = n.__k[r] = x$2(null, o, null, null, null) : g$2(o) ? o = n.__k[r] = x$2(S$1, { children: o }, null, null, null) : void 0 === o.constructor && o.__b > 0 ? o = n.__k[r] = x$2(o.type, o.props, o.key, o.ref ? o.ref : null, o.__v) : n.__k[r] = o, f = r + h, o.__ = n, o.__b = n.__b + 1, e = null, -1 != (c = o.__i = O(o, u, f, s)) && (s--, (e = u[c]) && (e.__u |= 2)), null == e || null == e.__v ? (-1 == c && (i > a ? h-- : i < a && h++), "function" != typeof o.type && (o.__u |= 4)) : c != f && (c == f - 1 ? h-- : c == f + 1 ? h++ : (c > f ? h-- : h++, o.__u |= 4))) : n.__k[r] = null;
	if (s) for (r = 0; r < a; r++) null != (e = u[r]) && 0 == (2 & e.__u) && (e.__e == t && (t = $(e)), K(e, e));
	return t;
}
function j$2(n, l, u) {
	var t, i;
	if ("function" == typeof n.type) {
		for (t = n.__k, i = 0; t && i < t.length; i++) t[i] && (t[i].__ = n, l = j$2(t[i], l, u));
		return l;
	}
	n.__e != l && (l && n.type && !l.parentNode && (l = $(n)), l = u.insertBefore(n.__e, l || null));
	do
		l = l && l.nextSibling;
	while (null != l && 8 == l.nodeType);
	return l;
}
function O(n, l, u, t) {
	var i, r, o, e = n.key, f = n.type, c = l[u], a = null != c && 0 == (2 & c.__u);
	if (null === c && null == e || a && e == c.key && f == c.type) return u;
	if (t > (a ? 1 : 0)) {
		for (i = u - 1, r = u + 1; i >= 0 || r < l.length;) if (null != (c = l[o = i >= 0 ? i-- : r++]) && 0 == (2 & c.__u) && e == c.key && f == c.type) return o;
	}
	return -1;
}
function z$1(n, l, u) {
	"-" == l[0] ? n.setProperty(l, null == u ? "" : u) : n[l] = null == u ? "" : "number" != typeof u || _$2.test(l) ? u : u + "px";
}
function N(n, l, u, t, i) {
	var r, o;
	n: if ("style" == l) if ("string" == typeof u) n.style.cssText = u;
	else {
		if ("string" == typeof t && (n.style.cssText = t = ""), t) for (l in t) u && l in u || z$1(n.style, l, "");
		if (u) for (l in u) t && u[l] == t[l] || z$1(n.style, l, u[l]);
	}
	else if ("o" == l[0] && "n" == l[1]) r = l != (l = l.replace(s$2, "$1")), o = l.toLowerCase(), l = o in n || "onFocusOut" == l || "onFocusIn" == l ? o.slice(2) : l.slice(2), n.l || (n.l = {}), n.l[l + r] = u, u ? t ? u[a$2] = t[a$2] : (u[a$2] = h$3, n.addEventListener(l, r ? v$2 : p$3, r)) : n.removeEventListener(l, r ? v$2 : p$3, r);
	else {
		if ("http://www.w3.org/2000/svg" == i) l = l.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
		else if ("width" != l && "height" != l && "href" != l && "list" != l && "form" != l && "tabIndex" != l && "download" != l && "rowSpan" != l && "colSpan" != l && "role" != l && "popover" != l && l in n) try {
			n[l] = null == u ? "" : u;
			break n;
		} catch (n) {}
		"function" == typeof u || (null == u || !1 === u && "-" != l[4] ? n.removeAttribute(l) : n.setAttribute(l, "popover" == l && 1 == u ? "" : u));
	}
}
function V(n) {
	return function(u) {
		if (this.l) {
			var t = this.l[u.type + n];
			if (null == u[c$2]) u[c$2] = h$3++;
			else if (u[c$2] < t[a$2]) return;
			return t(l$3.event ? l$3.event(u) : u);
		}
	};
}
function q$1(n, u, t, i, r, o, e, f, c, a) {
	var s, h, p, v, y, d, _, k, x, M, I, P, A, H, T, j, F = u.type;
	if (void 0 !== u.constructor) return null;
	128 & t.__u && (c = !!(32 & t.__u), o = [f = u.__e = t.__e]), (s = l$3.__b) && s(u);
	n: if ("function" == typeof F) {
		h = e.length;
		try {
			if (x = u.props, M = F.prototype && F.prototype.render, I = (s = F.contextType) && i[s.__c], P = s ? I ? I.props.value : s.__ : i, t.__c ? k = (p = u.__c = t.__c).__ = p.__E : (M ? u.__c = p = new F(x, P) : (u.__c = p = new C$1(x, P), p.constructor = F, p.render = Q), I && I.sub(p), p.state || (p.state = {}), p.__n = i, v = p.__d = !0, p.__h = [], p._sb = []), M && null == p.__s && (p.__s = p.state), M && null != F.getDerivedStateFromProps && (p.__s == p.state && (p.__s = m$2({}, p.__s)), m$2(p.__s, F.getDerivedStateFromProps(x, p.__s))), y = p.props, d = p.state, p.__v = u, v) M && null == F.getDerivedStateFromProps && null != p.componentWillMount && p.componentWillMount(), M && null != p.componentDidMount && p.__h.push(p.componentDidMount);
			else {
				if (M && null == F.getDerivedStateFromProps && x !== y && null != p.componentWillReceiveProps && p.componentWillReceiveProps(x, P), u.__v == t.__v || !p.__e && null != p.shouldComponentUpdate && !1 === p.shouldComponentUpdate(x, p.__s, P)) {
					u.__v != t.__v && (p.props = x, p.state = p.__s, p.__d = !1), u.__e = t.__e, u.__k = t.__k, u.__k.some(function(n) {
						n && (n.__ = u);
					}), w$3.push.apply(p.__h, p._sb), p._sb = [], p.__h.length && e.push(p), f = $(t);
					break n;
				}
				null != p.componentWillUpdate && p.componentWillUpdate(x, p.__s, P), M && null != p.componentDidUpdate && p.__h.push(function() {
					p.componentDidUpdate(y, d, _);
				});
			}
			if (p.context = P, p.props = x, p.__P = n, p.__e = !1, A = l$3.__r, H = 0, M) p.state = p.__s, p.__d = !1, A && A(u), s = p.render(p.props, p.state, p.context), w$3.push.apply(p.__h, p._sb), p._sb = [];
			else do
				p.__d = !1, A && A(u), s = p.render(p.props, p.state, p.context), p.state = p.__s;
			while (p.__d && ++H < 25);
			p.state = p.__s, null != p.getChildContext && (i = m$2(m$2({}, i), p.getChildContext())), M && !v && null != p.getSnapshotBeforeUpdate && (_ = p.getSnapshotBeforeUpdate(y, d)), T = null != s && s.type === S$1 && null == s.key ? E$1(s.props.children) : s, f = L(n, g$2(T) ? T : [T], u, t, i, r, o, e, f, c, a), p.base = u.__e, u.__u &= -161, p.__h.length && e.push(p), k && (p.__E = p.__ = null);
		} catch (n) {
			if (e.length = h, u.__v = null, c || null != o) {
				if (n.then) {
					for (u.__u |= c ? 160 : 128; f && 8 == f.nodeType && f.nextSibling;) f = f.nextSibling;
					null != o && (o[o.indexOf(f)] = null), u.__e = f;
				} else if (null != o) for (j = o.length; j--;) b$2(o[j]);
			} else u.__e = t.__e;
			u.__k ??= t.__k || [], n.then || B$1(u), l$3.__e(n, u, t);
		}
	} else null == o && u.__v == t.__v ? (u.__k = t.__k, u.__e = t.__e) : f = u.__e = G(t.__e, u, t, i, r, o, e, c, a);
	return (s = l$3.diffed) && s(u), 128 & u.__u ? void 0 : f;
}
function B$1(n) {
	n && (n.__c && (n.__c.__e = !0), n.__k && n.__k.some(B$1));
}
function D(n, u, t) {
	for (var i = 0; i < t.length; i++) J(t[i], t[++i], t[++i]);
	l$3.__c && l$3.__c(u, n), n.some(function(u) {
		try {
			n = u.__h, u.__h = [], n.some(function(n) {
				n.call(u);
			});
		} catch (n) {
			l$3.__e(n, u.__v);
		}
	});
}
function E$1(n) {
	return "object" != typeof n || null == n || n.__b > 0 ? n : g$2(n) ? n.map(E$1) : void 0 !== n.constructor ? null : m$2({}, n);
}
function G(u, t, i, r, o, e, f, c, a) {
	var s, h, p, v, y, w, _, m = i.props || d$2, k = t.props, x = t.type;
	if ("svg" == x ? o = "http://www.w3.org/2000/svg" : "math" == x ? o = "http://www.w3.org/1998/Math/MathML" : o || (o = "http://www.w3.org/1999/xhtml"), null != e) {
		for (s = 0; s < e.length; s++) if ((y = e[s]) && "setAttribute" in y == !!x && (x ? y.localName == x : 3 == y.nodeType)) {
			u = y, e[s] = null;
			break;
		}
	}
	if (null == u) {
		if (null == x) return document.createTextNode(k);
		u = document.createElementNS(o, x, k.is && k), c && (l$3.__m && l$3.__m(t, e), c = !1), e = null;
	}
	if (null == x) m === k || c && u.data == k || (u.data = k);
	else {
		if (e = "textarea" == x && null != k.defaultValue ? null : e && n$1.call(u.childNodes), !c && null != e) for (m = {}, s = 0; s < u.attributes.length; s++) m[(y = u.attributes[s]).name] = y.value;
		for (s in m) y = m[s], "dangerouslySetInnerHTML" == s ? p = y : "children" == s || s in k || "value" == s && "defaultValue" in k || "checked" == s && "defaultChecked" in k || N(u, s, null, y, o);
		for (s in k) y = k[s], "children" == s ? v = y : "dangerouslySetInnerHTML" == s ? h = y : "value" == s ? w = y : "checked" == s ? _ = y : c && "function" != typeof y || m[s] === y || N(u, s, y, m[s], o);
		if (h) c || p && (h.__html == p.__html || h.__html == u.innerHTML) || (u.innerHTML = h.__html), t.__k = [];
		else if (p && (u.innerHTML = ""), L("template" == t.type ? u.content : u, g$2(v) ? v : [v], t, i, r, "foreignObject" == x ? "http://www.w3.org/1999/xhtml" : o, e, f, e ? e[0] : i.__k && $(i, 0), c, a), null != e) for (s = e.length; s--;) b$2(e[s]);
		c && "textarea" != x || (s = "value", "progress" == x && null == w ? u.removeAttribute("value") : null != w && (w !== u[s] || "progress" == x && !w || "option" == x && w != m[s]) && N(u, s, w, m[s], o), s = "checked", null != _ && _ != u[s] && N(u, s, _, m[s], o));
	}
	return u;
}
function J(n, u, t) {
	try {
		if ("function" == typeof n) {
			var i = "function" == typeof n.__u;
			i && n.__u(), i && null == u || (n.__u = n(u));
		} else n.current = u;
	} catch (n) {
		l$3.__e(n, t);
	}
}
function K(n, u, t) {
	var i, r;
	if (l$3.unmount && l$3.unmount(n), (i = n.ref) && (i.current && i.current != n.__e || J(i, null, u)), null != (i = n.__c)) {
		if (i.componentWillUnmount) try {
			i.componentWillUnmount();
		} catch (n) {
			l$3.__e(n, u);
		}
		i.base = i.__P = i.__n = null;
	}
	if (i = n.__k) for (r = 0; r < i.length; r++) i[r] && K(i[r], u, t || "function" != typeof n.type);
	t || b$2(n.__e), n.__c = n.__ = n.__e = void 0;
}
function Q(n, l, u) {
	return this.constructor(n, u);
}
function R(u, t, i) {
	var r, o, e, f;
	t == document && (t = document.documentElement), l$3.__ && l$3.__(u, t), o = (r = "function" == typeof i) ? null : i && i.__k || t.__k, e = [], f = [], q$1(t, u = (!r && i || t).__k = k$1(S$1, null, [u]), o || d$2, d$2, t.namespaceURI, !r && i ? [i] : o ? null : t.firstChild ? n$1.call(t.childNodes) : null, e, !r && i ? i : o ? o.__e : t.firstChild, r, f), D(e, u, f), u.props.children = null;
}
n$1 = w$3.slice, l$3 = { __e: function(n, l, u, t) {
	for (var i, r, o; l = l.__;) if ((i = l.__c) && !i.__) try {
		if ((r = i.constructor) && null != r.getDerivedStateFromError && (i.setState(r.getDerivedStateFromError(n)), o = i.__d), null != i.componentDidCatch && (i.componentDidCatch(n, t || {}), o = i.__d), o) return i.__E = i;
	} catch (l) {
		n = l;
	}
	throw n;
} }, u$3 = 0, t$2 = function(n) {
	return null != n && void 0 === n.constructor;
}, C$1.prototype.setState = function(n, l) {
	var u = null != this.__s && this.__s != this.state ? this.__s : this.__s = m$2({}, this.state);
	"function" == typeof n && (n = n(m$2({}, u), this.props)), n && m$2(u, n), null != n && this.__v && (l && this._sb.push(l), A(this));
}, C$1.prototype.forceUpdate = function(n) {
	this.__v && (this.__e = !0, n && this.__h.push(n), A(this));
}, C$1.prototype.render = S$1, i$3 = [], o$2 = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e$2 = function(n, l) {
	return n.__v.__b - l.__v.__b;
}, H.__r = 0, f$3 = Math.random().toString(8), c$2 = "__d" + f$3, a$2 = "__a" + f$3, s$2 = /(PointerCapture)$|Capture$/i, h$3 = 0, p$3 = V(!1), v$2 = V(!0);
//#endregion
//#region ../../node_modules/.bun/preact@10.29.8/node_modules/preact/hooks/dist/hooks.module.js
var t$1;
var r$1;
var u$2;
var i$2;
var o$1 = 0;
var f$2 = [];
var c$1 = l$3;
var e$1 = c$1.__b;
var a$1 = c$1.__r;
var v$1 = c$1.diffed;
var l$2 = c$1.__c;
var m$1 = c$1.unmount;
var p$2 = c$1.__;
function s$1(n, t) {
	c$1.__h && c$1.__h(r$1, n, o$1 || t), o$1 = 0;
	var u = r$1.__H || (r$1.__H = {
		__: [],
		__h: []
	});
	return n >= u.__.length && u.__.push({}), u.__[n];
}
function h$2(n, u) {
	var i = s$1(t$1++, 3);
	!c$1.__s && C(i.__H, u) && (i.__ = n, i.u = u, r$1.__H.__h.push(i));
}
function T(n, r) {
	var u = s$1(t$1++, 7);
	return C(u.__H, r) && (u.__ = n(), u.__H = r, u.__h = n), u.__;
}
function j$1() {
	for (var n; n = f$2.shift();) {
		var t = n.__H;
		if (n.__P && t) try {
			t.__h.some(z), t.__h.some(B), t.__h = [];
		} catch (r) {
			t.__h = [], c$1.__e(r, n.__v);
		}
	}
}
c$1.__b = function(n) {
	r$1 = null, e$1 && e$1(n);
}, c$1.__ = function(n, t) {
	n && t.__k && t.__k.__m && (n.__m = t.__k.__m), p$2 && p$2(n, t);
}, c$1.__r = function(n) {
	a$1 && a$1(n), t$1 = 0;
	var i = (r$1 = n.__c).__H;
	i && (u$2 === r$1 ? (i.__h = [], r$1.__h = [], i.__.some(function(n) {
		n.__N && (n.__ = n.__N), n.u = n.__N = void 0;
	})) : (i.__h.some(z), i.__h.some(B), i.__h = [], t$1 = 0)), u$2 = r$1;
}, c$1.diffed = function(n) {
	v$1 && v$1(n);
	var t = n.__c;
	t && t.__H && (t.__H.__h.length && (1 !== f$2.push(t) && i$2 === c$1.requestAnimationFrame || ((i$2 = c$1.requestAnimationFrame) || w$2)(j$1)), t.__H.__.some(function(n) {
		n.u && (n.__H = n.u, n.u = void 0);
	})), u$2 = r$1 = null;
}, c$1.__c = function(n, t) {
	t.some(function(n) {
		try {
			n.__h.some(z), n.__h = n.__h.filter(function(n) {
				return !n.__ || B(n);
			});
		} catch (r) {
			t.some(function(n) {
				n.__h && (n.__h = []);
			}), t = [], c$1.__e(r, n.__v);
		}
	}), l$2 && l$2(n, t);
}, c$1.unmount = function(n) {
	m$1 && m$1(n);
	var t, r = n.__c;
	r && r.__H && (r.__H.__.some(function(n) {
		try {
			z(n);
		} catch (n) {
			t = n;
		}
	}), r.__H = void 0, t && c$1.__e(t, r.__v));
};
var k = "function" == typeof requestAnimationFrame;
function w$2(n) {
	var t, r = function() {
		clearTimeout(u), k && cancelAnimationFrame(t), setTimeout(n);
	}, u = setTimeout(r, 35);
	k && (t = requestAnimationFrame(r));
}
function z(n) {
	var t = r$1, u = n.__c;
	"function" == typeof u && (n.__c = void 0, u()), r$1 = t;
}
function B(n) {
	var t = r$1;
	n.__c = n.__(), r$1 = t;
}
function C(n, t) {
	return !n || n.length !== t.length || t.some(function(t, r) {
		return t !== n[r];
	});
}
//#endregion
//#region ../../node_modules/.bun/@preact+signals-core@1.14.4/node_modules/@preact/signals-core/dist/signals-core.module.js
var i$1 = Symbol.for("preact-signals");
function t() {
	if (!(v > 1)) {
		var i, t = !1;
		(function() {
			var i = c;
			c = void 0;
			while (void 0 !== i) {
				var t = i.S;
				if (t.v === i.v) {
					for (var n = t.t; void 0 !== n; n = n.x) if (n.i === i.i) n.i = t.i;
				}
				i = i.o;
			}
		})();
		while (void 0 !== h$1) {
			var n = h$1;
			h$1 = void 0;
			s++;
			while (void 0 !== n) {
				var r = n.u;
				n.u = void 0;
				n.f &= -3;
				if (!(8 & n.f) && w$1(n)) try {
					n.c();
				} catch (n) {
					if (!t) {
						i = n;
						t = !0;
					}
				}
				n = r;
			}
		}
		s = 0;
		v--;
		if (t) throw i;
	} else v--;
}
function n(i) {
	if (v > 0) return i();
	e = ++u$1;
	v++;
	try {
		return i();
	} finally {
		t();
	}
}
var r;
var o = void 0;
function f$1(i) {
	var t = o, n = r;
	o = void 0;
	r = void 0;
	try {
		return i();
	} finally {
		o = t;
		r = n;
	}
}
var h$1 = void 0;
var v = 0;
var s = 0;
var u$1 = 0;
var e = 0;
var c = void 0;
var d$1 = 0;
function a(i) {
	if (void 0 !== o) {
		var t = i.n;
		if (void 0 === t || t.t !== o) {
			t = {
				i: 0,
				S: i,
				p: o.s,
				n: void 0,
				t: o,
				e: void 0,
				x: void 0,
				r: t
			};
			if (void 0 !== o.s) o.s.n = t;
			o.s = t;
			i.n = t;
			if (32 & o.f) i.S(t);
			return t;
		} else if (-1 === t.i) {
			t.i = 0;
			if (void 0 !== t.n) {
				t.n.p = t.p;
				if (void 0 !== t.p) t.p.n = t.n;
				t.p = o.s;
				t.n = void 0;
				o.s.n = t;
				o.s = t;
			}
			return t;
		}
	}
}
function l$1(i, t) {
	this.v = i;
	this.i = 0;
	this.n = void 0;
	this.t = void 0;
	this.l = 0;
	this.W = null == t ? void 0 : t.watched;
	this.Z = null == t ? void 0 : t.unwatched;
	this.name = null == t ? void 0 : t.name;
}
l$1.prototype.brand = i$1;
l$1.prototype.h = function() {
	return !0;
};
l$1.prototype.S = function(i) {
	var t = this, n = this.t;
	if (n !== i && void 0 === i.e) {
		i.x = n;
		this.t = i;
		if (void 0 !== n) n.e = i;
		else f$1(function() {
			var i;
			null == (i = t.W) || i.call(t);
		});
	}
};
l$1.prototype.U = function(i) {
	var t = this;
	if (void 0 !== this.t) {
		var n = i.e, r = i.x;
		if (void 0 !== n) {
			n.x = r;
			i.e = void 0;
		}
		if (void 0 !== r) {
			r.e = n;
			i.x = void 0;
		}
		if (i === this.t) {
			this.t = r;
			if (void 0 === r) f$1(function() {
				var i;
				null == (i = t.Z) || i.call(t);
			});
		}
	}
};
l$1.prototype.subscribe = function(i) {
	var t = this;
	return j(function() {
		var n = t.value;
		f$1(function() {
			return i(n);
		});
	}, { name: "sub" });
};
l$1.prototype.valueOf = function() {
	return this.value;
};
l$1.prototype.toString = function() {
	return this.value + "";
};
l$1.prototype.toJSON = function() {
	return this.value;
};
l$1.prototype.peek = function() {
	var i = this;
	return f$1(function() {
		return i.value;
	});
};
Object.defineProperty(l$1.prototype, "value", {
	get: function() {
		var i = a(this);
		if (void 0 !== i) i.i = this.i;
		return this.v;
	},
	set: function(i) {
		if (i !== this.v) {
			if (s > 100) throw new Error("Cycle detected");
			(function(i) {
				if (0 !== v && 0 === s) {
					if (i.l !== e) {
						i.l = e;
						c = {
							S: i,
							v: i.v,
							i: i.i,
							o: c
						};
					}
				}
			})(this);
			this.v = i;
			this.i++;
			d$1++;
			v++;
			try {
				for (var n = this.t; void 0 !== n; n = n.x) n.t.N();
			} finally {
				t();
			}
		}
	}
});
function y$1(i, t) {
	return new l$1(i, t);
}
function w$1(i) {
	for (var t = i.s; void 0 !== t; t = t.n) if (t.S.i !== t.i || !t.S.h() || t.S.i !== t.i) return !0;
	return !1;
}
function _$1(i) {
	for (var t = i.s; void 0 !== t; t = t.n) {
		var n = t.S.n;
		if (void 0 !== n) t.r = n;
		t.S.n = t;
		t.i = -1;
		if (void 0 === t.n) {
			i.s = t;
			break;
		}
	}
}
function b$1(i) {
	var t = i.s, n = void 0;
	while (void 0 !== t) {
		var r = t.p;
		if (-1 === t.i) {
			t.S.U(t);
			if (void 0 !== r) r.n = t.n;
			if (void 0 !== t.n) t.n.p = r;
		} else n = t;
		t.S.n = t.r;
		if (void 0 !== t.r) t.r = void 0;
		t = r;
	}
	i.s = n;
}
function p$1(i, t) {
	l$1.call(this, void 0, t);
	this.x = i;
	this.s = void 0;
	this.g = d$1 - 1;
	this.f = 4;
}
p$1.prototype = new l$1();
p$1.prototype.h = function() {
	this.f &= -3;
	if (1 & this.f) return !1;
	if (32 == (36 & this.f)) return !0;
	this.f &= -5;
	if (this.g === d$1) return !0;
	this.g = d$1;
	this.f |= 1;
	if (this.i > 0 && !w$1(this)) {
		this.f &= -2;
		return !0;
	}
	var i = o;
	try {
		_$1(this);
		o = this;
		var t = this.x();
		if (16 & this.f || this.v !== t || 0 === this.i) {
			this.v = t;
			this.f &= -17;
			this.i++;
		}
	} catch (i) {
		this.v = i;
		this.f |= 16;
		this.i++;
	}
	o = i;
	b$1(this);
	this.f &= -2;
	return !0;
};
p$1.prototype.S = function(i) {
	if (void 0 === this.t) {
		this.f |= 36;
		for (var t = this.s; void 0 !== t; t = t.n) t.S.S(t);
	}
	l$1.prototype.S.call(this, i);
};
p$1.prototype.U = function(i) {
	if (void 0 !== this.t) {
		l$1.prototype.U.call(this, i);
		if (void 0 === this.t) {
			this.f &= -33;
			for (var t = this.s; void 0 !== t; t = t.n) t.S.U(t);
		}
	}
};
p$1.prototype.N = function() {
	if (!(2 & this.f)) {
		this.f |= 6;
		for (var i = this.t; void 0 !== i; i = i.x) i.t.N();
	}
};
Object.defineProperty(p$1.prototype, "value", { get: function() {
	if (1 & this.f) throw new Error("Cycle detected");
	var i = a(this);
	this.h();
	if (void 0 !== i) i.i = this.i;
	if (16 & this.f) throw this.v;
	return this.v;
} });
function g$1(i, t) {
	return new p$1(i, t);
}
function S(i) {
	var n = i.m;
	i.m = void 0;
	if ("function" == typeof n) {
		v++;
		var r = o;
		o = void 0;
		try {
			n();
		} catch (t) {
			i.f &= -2;
			i.f |= 8;
			m(i);
			throw t;
		} finally {
			o = r;
			t();
		}
	}
}
function m(i) {
	for (var t = i.s; void 0 !== t; t = t.n) t.S.U(t);
	i.x = void 0;
	i.s = void 0;
	S(i);
}
function x$1(i) {
	if (o !== this) throw new Error("Out-of-order effect");
	b$1(this);
	o = i;
	this.f &= -2;
	if (8 & this.f) m(this);
	t();
}
function E(i, t) {
	this.x = i;
	this.m = void 0;
	this.s = void 0;
	this.u = void 0;
	this.f = 32;
	this.name = null == t ? void 0 : t.name;
	if (r) r.push(this);
}
E.prototype.c = function() {
	var i = this.S();
	try {
		if (8 & this.f) return;
		if (void 0 === this.x) return;
		var t = this.x();
		if ("function" == typeof t) this.m = t;
	} finally {
		i();
	}
};
E.prototype.S = function() {
	if (1 & this.f) throw new Error("Cycle detected");
	this.f |= 1;
	this.f &= -9;
	S(this);
	_$1(this);
	v++;
	var i = o;
	o = this;
	return x$1.bind(this, i);
};
E.prototype.N = function() {
	if (!(2 & this.f)) {
		this.f |= 2;
		this.u = h$1;
		h$1 = this;
	}
};
E.prototype.d = function() {
	this.f |= 8;
	if (!(1 & this.f)) m(this);
};
E.prototype.dispose = function() {
	this.d();
};
function j(i, t) {
	var n = new E(i, t);
	try {
		n.c();
	} catch (i) {
		n.d();
		throw i;
	}
	var r = n.d.bind(n);
	r[Symbol.dispose] = r;
	return r;
}
//#endregion
//#region ../../node_modules/.bun/@preact+signals@2.11.2+aea0cee283550ea4/node_modules/@preact/signals/dist/signals.module.js
var l;
var d;
var p = "undefined" != typeof window && !!window.__PREACT_SIGNALS_DEVTOOLS__;
var _ = [];
j(function() {
	l = this.N;
})();
function g(i, r) {
	l$3[i] = r.bind(null, l$3[i] || function() {});
}
function b(i) {
	if (d) {
		var n = d;
		d = void 0;
		n();
	}
	d = i && i.S();
}
function y(i) {
	var n = this, t = i.data, f = useSignal(t);
	f.name = "ReactiveDom";
	f.value = t;
	var e = T(function() {
		var i = n, t = n.__v;
		while (t = t.__) if (t.__c) {
			t.__c.__$f |= 4;
			break;
		}
		var o = g$1(function() {
			var i = f.value.value;
			return 0 === i ? 0 : !0 === i ? "" : i || "";
		}), e = g$1(function() {
			return !Array.isArray(o.value) && !t$2(o.value);
		}), a = j(function() {
			this.N = F;
			if (e.value) {
				var n = o.value;
				if (i.__v && i.__v.__e && 3 === i.__v.__e.nodeType) i.__v.__e.data = n;
			}
		}), v = n.__$u.d;
		n.__$u.d = function() {
			a();
			v.call(this);
		};
		return [e, o];
	}, []), a = e[0], v = e[1];
	return a.value ? v.peek() : v.value;
}
y.displayName = "ReactiveTextNode";
Object.defineProperties(l$1.prototype, {
	constructor: {
		configurable: !0,
		value: void 0
	},
	type: {
		configurable: !0,
		value: y
	},
	props: {
		configurable: !0,
		get: function() {
			var i = this;
			return { data: { get value() {
				return i.value;
			} } };
		}
	},
	__b: {
		configurable: !0,
		value: 1
	}
});
g("__b", function(i, n) {
	b();
	if ("string" == typeof n.type) {
		var r, t = n.props;
		for (var o in t) if ("children" !== o) {
			var f = t[o];
			if (f instanceof l$1) {
				if (!r) n.__np = r = {};
				r[o] = f;
				t[o] = f.peek();
			}
		}
	}
	i(n);
});
g("__r", function(i, n) {
	i(n);
	if (n.type !== S$1) {
		b();
		var r, o = n.__c;
		if (o) {
			o.__$f &= -2;
			if (void 0 === (r = o.__$u)) o.__$u = r = function(i, n) {
				var r;
				j(function() {
					r = this;
				}, { name: n });
				r.c = i;
				return r;
			}(function(i) {
				return function() {
					var n;
					if (p) null == (n = this.y) || n.call(this);
					i.__$f |= 1;
					i.setState({});
				};
			}(o), "function" == typeof n.type ? n.type.displayName || n.type.name : "");
		}
		b(r);
	}
});
g("__e", function(i, n, r, t) {
	b();
	i(n, r, t);
});
g("diffed", function(i, n) {
	b();
	var r;
	if ("string" == typeof n.type && (r = n.__e)) {
		var t = n.__np, o = n.props, f = r.U;
		if (f) for (var e in f) {
			var u = f[e];
			if (!(void 0 === u || t && e in t)) {
				u.d();
				f[e] = void 0;
			}
		}
		if (t) {
			if (!f) {
				f = {};
				r.U = f;
			}
			for (var a in t) {
				var c = f[a], v = t[a];
				if (void 0 === c) {
					c = w(r, a, v, o);
					f[a] = c;
				} else c.o(v, o);
			}
		}
	}
	i(n);
});
function w(i, n, r, t) {
	var o = n in i && void 0 === i.ownerSVGElement, f = y$1(r);
	return {
		o: function(i, n) {
			f.value = i;
			t = n;
		},
		d: j(function() {
			this.N = F;
			var r = f.value.value;
			if (t[n] !== r) {
				t[n] = r;
				if (o) i[n] = r;
				else if (null != r && (!1 !== r || "-" === n[4])) i.setAttribute(n, r);
				else i.removeAttribute(n);
			}
		})
	};
}
g("unmount", function(i, n) {
	if ("string" == typeof n.type) {
		var r = n.__e;
		if (r) {
			var t = r.U;
			if (t) {
				r.U = void 0;
				for (var o in t) {
					var f = t[o];
					if (f) f.d();
				}
			}
		}
		var e = n.__np;
		if (e) {
			var u = n.props;
			for (var a in e) u[a] = e[a];
		}
		n.__np = void 0;
	} else {
		var c = n.__c;
		if (c) {
			var v = c.__$u;
			if (v) {
				c.__$u = void 0;
				v.d();
			}
		}
	}
	i(n);
});
g("__h", function(i, n, r, t) {
	if (t < 3) n.__$f |= 2;
	i(n, r, t);
});
C$1.prototype.shouldComponentUpdate = function(i, n) {
	if (this.__R) return !0;
	var r = this.__$u, t = r && void 0 !== r.s;
	for (var o in n) return !0;
	if (this.__f || "boolean" == typeof this.u && !0 === this.u) {
		var f = 2 & this.__$f;
		if (!(t || f || 4 & this.__$f)) return !0;
		if (1 & this.__$f) return !0;
	} else {
		if (!(t || 4 & this.__$f)) return !0;
		if (3 & this.__$f) return !0;
	}
	for (var e in i) if ("__source" !== e && i[e] !== this.props[e]) return !0;
	for (var u in this.props) if (!(u in i)) return !0;
	return !1;
};
function useSignal(i, n) {
	return T(function() {
		return y$1(i, n);
	}, []);
}
var q = function(i) {
	queueMicrotask(function() {
		queueMicrotask(i);
	});
};
function x() {
	n(function() {
		var i;
		while (i = _.shift()) l.call(i);
	});
}
function F() {
	if (1 === _.push(this)) (l$3.requestAnimationFrame || q)(x);
}
//#endregion
//#region src/core/messaging.ts
/**
* Typed wrapper around `chrome.runtime.sendMessage`.
*
* Chrome resolves the promise with `undefined` and sets `lastError` when the
* service worker is asleep or has thrown. Surfacing that as a rejection means
* callers cannot accidentally treat a dropped message as an empty result.
*/
async function send(message) {
	const reply = await chrome.runtime.sendMessage(message);
	if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message ?? "message failed");
	if (reply === void 0) throw new Error(`404AD: no response to ${message.type}`);
	if (!reply.ok) throw new Error(reply.error);
	return reply.data;
}
//#endregion
//#region src/ui/state.ts
/**
* Shared UI state.
*
* The service worker is the single source of truth; these signals are a cache
* of its answers. Every mutation goes through a message and then re-reads, so
* the UI can never drift from what the engine is actually doing.
*/
var settings = y$1(null);
var tab = y$1(null);
var status = y$1(null);
var stats = y$1(null);
var sites = y$1([]);
var matches = y$1([]);
var error = y$1(null);
async function guard(run) {
	try {
		const value = await run();
		error.value = null;
		return value;
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
		return null;
	}
}
async function refreshSettings() {
	const value = await guard(() => send({ type: "settings:get" }));
	if (value) settings.value = value;
}
async function patchSettings(patch) {
	const value = await guard(() => send({
		type: "settings:set",
		patch
	}));
	if (value) settings.value = value;
}
async function refreshTab() {
	const value = await guard(() => send({ type: "tab:state" }));
	if (value) tab.value = value;
}
async function refreshStatus() {
	const value = await guard(() => send({ type: "engine:status" }));
	if (value) status.value = value;
}
async function refreshStats() {
	const value = await guard(() => send({ type: "stats:get" }));
	if (value) stats.value = value;
}
async function refreshSites() {
	const value = await guard(() => send({ type: "site:list" }));
	if (value) sites.value = value;
}
async function refreshMatches(tabId) {
	const value = await guard(() => send({
		type: "diagnostics:recent",
		tabId
	}));
	if (value) matches.value = value;
}
async function setMode(host, mode, durationMs) {
	await guard(() => send({
		type: "site:set",
		host,
		mode,
		durationMs
	}));
	await Promise.all([refreshTab(), refreshSites()]);
}
function formatCount(n) {
	if (n < 1e3) return String(n);
	if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
	return `${(n / 1e6).toFixed(1)}M`;
}
//#endregion
//#region ../../node_modules/.bun/preact@10.29.8/node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
var f = 0;
Array.isArray;
function u(e, t, n, o, i, u) {
	t || (t = {});
	var a, c, p = t;
	if ("ref" in p) for (c in p = {}, t) "ref" == c ? a = t[c] : p[c] = t[c];
	var l = {
		type: e,
		props: p,
		key: n,
		ref: a,
		__k: null,
		__: null,
		__b: 0,
		__e: null,
		__c: null,
		constructor: void 0,
		__v: --f,
		__i: -1,
		__u: 0,
		__source: i,
		__self: u
	};
	if ("function" == typeof e && (a = e.defaultProps)) for (c in a) void 0 === p[c] && (p[c] = a[c]);
	return l$3.vnode && l$3.vnode(l), l;
}
//#endregion
export { S$1 as C, R as S, tab as _, patchSettings as a, y$1 as b, refreshSites as c, refreshTab as d, setMode as f, status as g, stats as h, matches as i, refreshStats as l, sites as m, error as n, refreshMatches as o, settings as p, formatCount as r, refreshSettings as s, u as t, refreshStatus as u, send as v, h$2 as x, useSignal as y };
