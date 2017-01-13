import {list} from 'postcss';
import {detect} from 'stylehacks';
import assign from 'object-assign';
import clone from '../clone';
import genericMerge from '../genericMerge';
import insertCloned from '../insertCloned';
import parseTrbl from '../parseTrbl';
import hasAllProps from '../hasAllProps';
import getLastNode from '../getLastNode';
import getDecls from '../getDecls';
import getRules from '../getRules';
import getValue from '../getValue';
import minifyTrbl from '../minifyTrbl';
import canMerge from '../canMerge';
import colorMerge from '../colorMerge';
import remove from '../remove';
import trbl from '../trbl';

const wsc = ['width', 'style', 'color'];
const defaults = ['medium', 'none', 'currentColor'];

function borderProperty (...parts) {
    return `border-${parts.join('-')}`;
}

function mapBorderProperty (value) {
    return borderProperty(value);
}

const directions = trbl.map(mapBorderProperty);
const properties = wsc.map(mapBorderProperty);

function mergeRedundant ({values, nextValues, decl, nextDecl, index, position, prop}) {
    let props = parseTrbl(values[position]);
    props[index] = nextValues[position];
    values.splice(position, 1);
    let borderValue = values.join(' ');
    let propertyValue = minifyTrbl(props);

    let origLength = (decl.value + nextDecl.prop + nextDecl.value).length;
    let newLength = borderValue.length + 12 + propertyValue.length;

    if (newLength < origLength) {
        decl.value = borderValue;
        nextDecl.prop = prop;
        nextDecl.value = propertyValue;
    }
}

function isCloseEnough (mapped) {
    return (mapped[0] === mapped[1] && mapped[1] === mapped[2]) ||
           (mapped[1] === mapped[2] && mapped[2] === mapped[3]) ||
           (mapped[2] === mapped[3] && mapped[3] === mapped[0]) ||
           (mapped[3] === mapped[0] && mapped[0] === mapped[1]);
}

function getDistinctShorthands (mapped) {
    return mapped.reduce((a, b) => {
        a = Array.isArray(a) ? a : [a];
        if (!~a.indexOf(b)) {
            a.push(b);
        }
        return a;
    });
}

function explode (rule) {
    if (rule.nodes.some(detect)) {
        return false;
    }
    rule.walkDecls(/^border/, decl => {
        // Don't explode inherit values as they cannot be merged together
        if (decl.value === 'inherit') {
            return;
        }
        const {prop} = decl;
        // border -> border-trbl
        if (prop === 'border') {
            directions.forEach((direction) => {
                insertCloned(rule, decl, {prop: direction});
            });
            return decl.remove();
        }
        // border-trbl -> border-trbl-wsc
        if (directions.some(direction => prop === direction)) {
            let values = list.space(decl.value);
            wsc.forEach((d, i) => {
                insertCloned(rule, decl, {
                    prop: `${prop}-${d}`,
                    value: values[i] || defaults[i],
                });
            });
            return decl.remove();
        }
        // border-wsc -> border-trbl-wsc
        wsc.some(style => {
            if (prop !== borderProperty(style)) {
                return false;
            }
            parseTrbl(decl.value).forEach((value, i) => {
                insertCloned(rule, decl, {
                    prop: borderProperty(trbl[i], style),
                    value,
                });
            });
            return decl.remove();
        });
    });
}

const borderProperties = trbl.reduce((props, direction) => {
    return [
        ...props,
        ...wsc.map(style => borderProperty(direction, style)),
    ];
}, []);

function merge (rule) {
    // Lift all inherit values from the rule, so that they don't
    // interfere with the merging logic.
    const inheritValues = getDecls(rule, borderProperties).reduce((values, decl) => {
        if (decl.value === 'inherit') {
            decl.remove();
            return [
                ...values,
                decl,
            ];
        }
        return values;
    }, []);
    // border-trbl-wsc -> border-trbl
    trbl.forEach(direction => {
        const prop = borderProperty(direction);
        genericMerge({
            rule,
            prop,
            properties: wsc.map(style => borderProperty(direction, style)),
            value: rules => rules.map(getValue).join(' '),
        });
    });

    // border-trbl-wsc -> border-wsc
    wsc.forEach(style => {
        const prop = borderProperty(style);
        if (style === 'color') {
            return colorMerge({
                rule,
                prop,
                properties: trbl.map(direction => borderProperty(direction, style)),
                value: rules => minifyTrbl(rules.map(getValue).join(' ')),
            });
        }
        return genericMerge({
            rule,
            prop,
            properties: trbl.map(direction => borderProperty(direction, style)),
            value: rules => minifyTrbl(rules.map(getValue).join(' ')),
            sanitize: false,
        });
    });

    // border-trbl -> border-wsc
    let decls = getDecls(rule, directions);
    while (decls.length) {
        const lastNode = decls[decls.length - 1];
        const props = decls.filter(node => node.important === lastNode.important);
        const rules = getRules(props, directions);
        if (hasAllProps(props, ...directions)) {
            wsc.forEach((d, i) => {
                insertCloned(rule, lastNode, {
                    prop: borderProperty(d),
                    value: minifyTrbl(rules.map(node => list.space(node.value)[i])),
                });
            });
            props.forEach(remove);
        }
        decls = decls.filter(node => !~rules.indexOf(node));
    }

    // border-wsc -> border
    // border-wsc -> border + border-color
    // border-wsc -> border + border-dir
    decls = getDecls(rule, properties);

    while (decls.length) {
        const lastNode = decls[decls.length - 1];
        const props = decls.filter(node => node.important === lastNode.important);
        if (hasAllProps(props, ...properties)) {
            const rules = properties.map(prop => getLastNode(props, prop));
            const [width, style, color] = rules;
            const values = rules.map(node => parseTrbl(node.value));
            const mapped = [0, 1, 2, 3].map(i => [values[0][i], values[1][i], values[2][i]].join(' '));
            const reduced = getDistinctShorthands(mapped);

            if (isCloseEnough(mapped) && canMerge(...rules)) {
                const first = mapped.indexOf(reduced[0]) !== mapped.lastIndexOf(reduced[0]);

                const border = insertCloned(rule, lastNode, {
                    prop: 'border',
                    value: first ? reduced[0] : reduced[1],
                });

                if (reduced[1]) {
                    const value = first ? reduced[1] : reduced[0];
                    const prop = borderProperty(trbl[mapped.indexOf(value)]);

                    rule.insertAfter(border, assign(clone(lastNode), {
                        prop,
                        value,
                    }));
                }
                props.forEach(remove);
            } else if (reduced.length === 1) {
                rule.insertBefore(color, assign(clone(lastNode), {
                    prop: 'border',
                    value: [width, style].map(getValue).join(' '),
                }));
                props.filter(node => node.prop !== properties[2]).forEach(remove);
            }
        }
        decls = decls.filter(node => !~props.indexOf(node));
    }

    // optimize border-trbl
    decls = getDecls(rule, directions);
    while (decls.length) {
        const lastNode = decls[decls.length - 1];
        wsc.forEach((d, i) => {
            const names = directions.filter(name => name !== lastNode.prop).map(name => `${name}-${d}`);
            const props = rule.nodes.filter(node => node.prop && ~names.indexOf(node.prop) && node.important === lastNode.important);
            if (hasAllProps(props, ...names)) {
                const values = directions.map(prop => getLastNode(props, `${prop}-${d}`)).map(node => node ? node.value : null);
                const filteredValues = values.filter(Boolean);
                const lastNodeValue = list.space(lastNode.value)[i];
                values[directions.indexOf(lastNode.prop)] = lastNodeValue;
                let value = minifyTrbl(values.join(' '));
                if (
                    filteredValues[0] === filteredValues[1] &&
                    filteredValues[1] === filteredValues[2]
                ) {
                    value = filteredValues[0];
                }
                let refNode = props[props.length - 1];
                if (value === lastNodeValue) {
                    refNode = lastNode;
                    let valueArray = list.space(lastNode.value);
                    valueArray.splice(i, 1);
                    lastNode.value = valueArray.join(' ');
                }
                insertCloned(rule, refNode, {
                    prop: borderProperty(d),
                    value,
                });
                props.forEach(remove);
            }
        });
        decls = decls.filter(node => node !== lastNode);
    }

    rule.walkDecls('border', decl => {
        const nextDecl = decl.next();
        if (!nextDecl || nextDecl.type !== 'decl') {
            return;
        }
        const index = directions.indexOf(nextDecl.prop);
        if (!~index) {
            return;
        }
        const values = list.space(decl.value);
        const nextValues = list.space(nextDecl.value);

        const config = {
            values,
            nextValues,
            decl,
            nextDecl,
            index,
        };

        if (
            values[0] === nextValues[0] &&
            values[2] === nextValues[2]
        ) {
            return mergeRedundant({
                ...config,
                position: 1,
                prop: 'border-style',
            });
        }

        if (
            values[1] === nextValues[1] &&
            values[2] === nextValues[2]
        ) {
            return mergeRedundant({
                ...config,
                position: 0,
                prop: 'border-width',
            });
        }

        if (
            values[0] === nextValues[0] &&
            values[1] === nextValues[1] &&
            values[2] && nextValues[2]
        ) {
            return mergeRedundant({
                ...config,
                position: 2,
                prop: 'border-color',
            });
        }
    });

    // clean-up values
    rule.walkDecls(/^border($|-(top|right|bottom|left))/, decl => {
        const value = [...list.space(decl.value), ''].reduceRight((prev, cur, i) => {
            if (prev === '' && cur === defaults[i]) {
                return prev;
            }
            return cur + ' ' + prev;
        }).trim() || defaults[0];
        decl.value = minifyTrbl(value);
    });

    // Restore inherited values
    inheritValues.forEach(decl => rule.append(decl));
}

export default {
    explode,
    merge,
};