// Text rendering style

import Texture from '../../gl/texture';
import WorkerBroker from '../../utils/worker_broker';
import Utils from '../../utils/utils';
import {Points} from '../points/points';
import CanvasText from './canvas_text';
import LabelBuilder from './label_builder';
import FeatureLabel from './feature_label';
import LabelOptions from './label_options';
import {StyleParser} from '../style_parser';

import log from 'loglevel';

export let TextStyle = Object.create(Points);

Object.assign(TextStyle, {
    name: 'text',
    super: Points,
    built_in: true,
    selection: false, // no feature selection for text by default

    init() {

        this.super.init.apply(this, arguments);

        // Provide a hook for this object to be called from worker threads
        this.main_thread_target = 'TextStyle-' + this.name;
        if (Utils.isMainThread) {
            WorkerBroker.addTarget(this.main_thread_target, this);
        }

        // Point style (parent class) requires texturing to be turned on
        // (labels are always drawn with textures)
        this.defines.TANGRAM_POINT_TEXTURE = true;

        // Manually un-multiply alpha, because Canvas text rasterization is pre-multiplied
        this.defines.TANGRAM_UNMULTIPLY_ALPHA = true;

        // default font style
        this.default_font_style = {
            style: 'normal',
            weight: null,
            size: '12px',
            px_size: 12,
            family: 'Helvetica',
            fill: 'white',
            text_wrap: 15,
            align: 'center'
        };

        this.reset();
    },

    reset() {
        this.super.reset.call(this);
        this.texts = {}; // unique texts, keyed by tile
        this.textures = {};
        this.canvas = {};
        this.aabbs = {};
        this.features = {};
        this.feature_labels = {};
        this.feature_style_key = {};
    },

    // Called on main thread to release tile-specific resources
    freeTile (tile) {
        delete this.texts[tile];
        delete this.textures[tile];
        delete this.canvas[tile];
        delete this.aabbs[tile];
        // cleanup stored features for this tile
        for (let key in this.features) {
            let features = this.features[key];
            for (let i = 0; i < features.length; ++i) {
                if (features[i].tile_key === tile) {
                    delete features[i];
                }
            }
            if (Object.keys(features).length === 0) {
                delete this.features[key];
            }
        }
        delete this.feature_labels[tile];
        delete this.feature_style_key[tile];
    },

    calcTextSizes (tile, texts) {
        if(!this.canvas[tile]) {
            this.canvas[tile] = new CanvasText();
        }

        return this.canvas[tile].textSizes(tile, texts);
    },

    // Called on main thread from worker, to create atlas of labels for a tile
    addTexts (tile, texts) {
        if (!this.canvas[tile]) {
            return Promise.resolve({});
        }

        let canvas = this.canvas[tile];
        let texture_size = canvas.setTextureTextPositions(texts);

        log.trace(`text summary for tile ${tile}: fits in ${texture_size[0]}x${texture_size[1]}px`);

        // update the canvas to texture size
        canvas.resize(...texture_size);

        // create a texture
        let texture = 'labels-' + tile + '-' + (TextStyle.texture_id++);
        this.textures[tile] = new Texture(this.gl, texture);

        // ask for rasterization for the text set
        canvas.rasterize(tile, texts, texture_size);

        this.textures[tile].setCanvas(canvas.canvas, {
            filtering: 'linear',
            UNPACK_PREMULTIPLY_ALPHA_WEBGL: true
        });

        // we don't need tile canvas/texture once it has been copied to to GPU
        delete this.textures[tile];
        delete this.canvas[tile];

        return Promise.resolve({ texts, texture });
    },

    // Override
    startData (tile) {
        let tile_data = this.super.startData.apply(this, arguments);
        tile_data.queue = [];
        return tile_data;
    },

    createLabels (tile, texts) {
        let labels_priorities = {};  // this will store all labels in the tile,
                                     // sorted into objects by priority

        // texts holds text_info objects, keyed by style
        // Example:
        // Object {
        //     "100 24px Helvetica/rgb(102,102,102)/rgb(255,255,255)/8": Object {
        //         East 10th Street: Object,
        //         East 12th Street: Object
        //     },
        //     "100 32px Helvetica/rgb(102,102,102)/rgb(255,255,255)/8": Object {
        //         3rd Avenue: Object
        //     }
        // }

        // for each style key
        for (let style in texts) {
            let text_infos = texts[style];

            // text_infos holds text objects, keyed by text
            // Example:
            // Object: {
            //      "3rd Avenue": Object {
            //          priority: 3,
            //          ref: 1,
            //          size: Object,
            //          text_style: Object
            //      }
            // }

            // for each text object:
            for (let text in text_infos) {
                let text_info = text_infos[text];
                text_info.ref = 0;

                let hash = Utils.hashString(tile + style + text);

                if (!this.features[hash]) {
                    continue;
                }

                let label_features = this.features[hash];
                // this.features holds all features, keyed by tile, then style, then text

                // for each feature
                for (let i = 0; i < label_features.length; ++i) {
                    let label_feature = label_features[i];
                    let feature = label_feature.feature;
                    let options = new LabelOptions(text_info);

                    // build a label for each text_info object
                    let labels = LabelBuilder.buildFromGeometry(text, text_info.size, feature.geometry, options);

                    for (let i = 0; i < labels.length; ++i) {
                        let label = labels[i];
                        let area = label.area;

                        labels_priorities[text_info.priority] = labels_priorities[text_info.priority] || [];
                        labels_priorities[text_info.priority].push({ style, feature, label, area });
                    }
                }
            }
        }

        // sort by area size if defined
        for (let p = 0; p < labels_priorities.length; ++p) {
            if (!labels_priorities[p]) {
                continue;
            }

            labels_priorities[p].sort((e1, e2) => {
                if (e1.area && e2.area) {
                    return e1.area < e2.area;
                } else {
                    return false;
                }
            });
        }

        return labels_priorities;
    },

    // test all labels for collisions -
    // when two collide, discard the lower-priority label
    discardLabels (tile, labels, texts) {
        this.aabbs[tile] = [];
        this.feature_labels[tile] = new Map();

        // Process labels by priority
        let priorities = Object.keys(labels).sort((a, b) => a - b);
        for (let priority of priorities) {
            if (!labels[priority]) { // no labels at this priority, skip to next
                continue;
            }

            for (let i = 0; i < labels[priority].length; i++) {
                let { style, feature, label } = labels[priority][i];

                // test the label for intersections with other labels in the tile
                if (!label.discard(this.aabbs[tile])) {
                    // if it didn't collide
                    if (!this.feature_labels[tile].has(feature)) {
                        // if the label was just made, make a new empty entry in this
                        // tile's feature_labels using the feature as the key -
                        // the entry will be used as the style.labels
                        this.feature_labels[tile].set(feature, []);
                    }
                    // add the label to the entry's value
                    this.feature_labels[tile].get(feature).push(label);
                    // increment a count of how many times this style is used in the tile
                    texts[style][label.text].ref++;
                }
            }
        }

        for (let style in texts) {
            for (let text in texts[style]) {
                if (texts[style][text].ref < 1) { // if this style isn't being used
                    delete texts[style][text]; // cleanup
                }
            }
        }

        for (let style in texts) {
            let text_infos = texts[style];
            if (Object.keys(text_infos).length === 0) {
                // No labels for this style
                delete texts[style];
            }
        }
    },

    // Override
    endData (tile) {
        // Count collected text
        let count;
        let tile_data = this.tile_data[tile];

        if (tile_data.queue.length > 0) {
            count = Object.keys(this.texts[tile]||{}).length;
            log.trace(`# texts for tile ${tile}: ${count}`);
        }
        if (!count) {
            return Promise.resolve();
        }

        // first call to main thread, ask for text pixel sizes
        return WorkerBroker.postMessage(this.main_thread_target, 'calcTextSizes', tile, this.texts[tile]).then(texts => {
            if (!texts) {
                this.freeTile(tile);
                return this.super.endData.apply(this, arguments);
            }

            let labels = this.createLabels(tile, texts);
            if (!labels) {
                this.freeTile(tile);
                return this.super.endData.apply(this, arguments);
            }

            this.discardLabels(tile, labels, texts);

            // No labels for this tile
            if (Object.keys(texts).length === 0) {
                this.freeTile(tile);
                WorkerBroker.postMessage(this.main_thread_target, 'freeTile', tile);
                // early exit
                return;
            }

            // second call to main thread, for rasterizing the set of texts
            return WorkerBroker.postMessage(this.main_thread_target, 'addTexts', tile, texts).then(({ texts, texture }) => {
                if (texts) {
                    this.texts[tile] = texts;

                    // Attach tile-specific label atlas to mesh as a texture uniform
                    tile_data.uniforms = { u_texture: texture };
                    tile_data.textures = [texture]; // assign texture ownership to tile - TODO: implement in VBOMesh

                    // Build queued features
                    tile_data.queue.forEach(q => this.super.addFeature.apply(this, q));
                    tile_data.queue = [];
                }

                this.freeTile(tile);
                return this.super.endData.apply(this, arguments);
            });
        });
    },

    // Override to queue features instead of processing immediately
    addFeature (feature, rule, context) {
        let tile = context.tile;
        if (tile.generation !== this.generation) {
            return;
        }

        // Called here because otherwise it will be delayed until the feature queue is parsed,
        // and we want the preprocessing done before we evaluate text style below
        this.preprocessFeatureStyle(rule);

        // Collect text - default source is feature.properties.name
        let text;
        let source = rule.text_source || 'name';

        if (typeof source === 'string') {
            text = feature.properties[source];
        } else if (typeof source === 'function') {
            text = source(context);
        }

        if (text) {
            feature.text = text;

            if (!this.texts[tile.key]) {
                // this is the first label in the tile, make a new tile entry
                // eg "osm/15/9650/12319/15"
                this.texts[tile.key] = this.texts[tile.key] || {};
            }

            // features stored by hash for later use from main thread (tile / text / style)
            let label_feature = new FeatureLabel(feature, rule, context, text, tile, this.default_font_style);
            let feature_hash = label_feature.getHash();

            if (!label_feature.style) {
                return;
            }

            let style_key = label_feature.style_key;
            this.feature_style_key[tile.key] = this.feature_style_key[tile.key] || new Map();
            this.feature_style_key[tile.key].set(feature, style_key);

            if (!this.texts[tile.key][style_key]) {
                // first label with this style in this tile, make a new style entry
                // example: "100 24px Helvetica/rgb(102,102,102)/rgb(255,255,255)/8"
                this.texts[tile.key][style_key] = {};
            }

            // label priority (lower is higher)
            let priority = rule.priority;
            if (priority !== undefined) {
                // if priority is a number, use it as-is, otherwise, check type
                // if (typeof priority === 'string') {
                //     priority = feature.properties[priority]; // get priority from feature property
                // }
                // else if (typeof priority === 'function') {
                if (typeof priority === 'function') {
                    priority = priority(context);
                }
            }
            else {
                priority = -1 >>> 0; // default to max priority value if none set
            }

            // label offset in pixel (applied in screen space)
            let offset = rule.offset || [0, 0];
            offset[0] = parseFloat(offset[0]);
            offset[1] = parseFloat(offset[1]); // y-point down

            // label anchors (point labels only)
            // label will be adjusted in the given direction, relatove to its original point
            // one of: left, right, top, bottom, top-left, top-right, bottom-left, bottom-right
            let anchor = rule.anchor;

            // label buffer in pixel
            let buffer = rule.buffer;
            if (buffer != null) {
                if (!Array.isArray(buffer)) {
                    buffer = [buffer, buffer]; // buffer can be 1D or 2D
                }

                buffer[0] = parseFloat(buffer[0]);
                buffer[1] = parseFloat(buffer[1]);
            }

            // label line exceed percentage
            let line_exceed;
            if (rule.line_exceed && rule.line_exceed.substr(-1) === '%') {
                line_exceed = rule.line_exceed.substr(0,rule.line_exceed.length-1);
            }

            if (!this.texts[tile.key][style_key][text]) {
                // first label with this text/style/tile combination, make a new label entry
                this.texts[tile.key][style_key][text] = {
                    text_style: label_feature.style,
                    units_per_pixel: tile.units_per_pixel,
                    priority,
                    offset,
                    buffer,
                    anchor,
                    line_exceed,
                    move_into_tile: rule.move_into_tile,
                    ref: 0
                };
            }

            // add the label feature
            this.features = this.features || {};
            this.features[feature_hash] = this.features[feature_hash] || [];
            this.features[feature_hash].push(label_feature);

            if (!this.tile_data[tile.key]) {
                this.startData(tile.key);
            }
            this.tile_data[tile.key].queue.push([feature, rule, context]);
        }
    },

    preprocess (draw) {
        if (!draw.font) {
            return;
        }

        // Setup caching for colors
        draw.font.fill = draw.font.fill && { value: draw.font.fill };
        if (draw.font.stroke) {
            draw.font.stroke.color = draw.font.stroke.color && { value: draw.font.stroke.color };
        }

        // Convert font units and setup caching for zoom interpolation if needed
        if (Array.isArray(draw.font.size)) {
            // convert all stops
            draw.font.px_size = draw.font.size.map(v => [v[0], CanvasText.fontPixelSize(v[1])]);

            // presence of this property indicates size should be evaluated + cached at each zoom
            draw.font.px_size_by_zoom = {};
        }
        else {
            draw.font.px_size = CanvasText.fontPixelSize(draw.font.size);
        }

        // Same prep as above, for text stroke
        if (draw.font.stroke && draw.font.stroke.width != null) {
            if (Array.isArray(draw.font.stroke.width)) {
                draw.font.stroke.width = draw.font.stroke.width.map(v => [v[0], parseFloat(v[1])]);
                draw.font.stroke.width_by_zoom = {};
            }
            else {
                draw.font.stroke.width = parseFloat(draw.font.stroke.width);
            }
        }
    },

    build (style, vertex_data) {
        let vertex_template = this.makeVertexTemplate(style);

        for (let i in style.labels) {
            let label = style.labels[i];

            this.buildQuad(
                [label.position],
                label.size.texture_text_size,
                Utils.radToDeg(label.angle) || 0, vertex_data,
                vertex_template, label.options.offset
            );
        }
    },

    buildLines (lines, style, vertex_data) {
        this.build(style, vertex_data);
    },

    buildPoints (points, style, vertex_data) {
        this.build(style, vertex_data);
    },

    buildPolygons (points, style, vertex_data) {
        this.build(style, vertex_data);
    },

    _parseFeature (feature, rule_style, context) {
        let text = feature.text;

        let style = this.feature_style;
        let tile = context.tile.key;
        let style_key = this.feature_style_key[tile].get(feature);
        let text_info = this.texts[tile] && this.texts[tile][style_key] && this.texts[tile][style_key][text];

        if (!text_info || !this.feature_labels[tile].has(feature)) {
            return;
        }

        this.texcoord_scale = text_info.texcoords;
        style.text = text;
        // add the labels from the feature_labels object for this tile
        style.labels = this.feature_labels[tile].get(feature);

        // TODO: point style (parent class) requires a color, setting it to white for now,
        // but could be made conditional in the vertex layout to save space
        style.color = TextStyle.white;

        // tell the point style (base class) that we want to render polygon labels at the polygon's centroid
        style.centroid = true;

        // points can be placed off the ground
        style.z = (rule_style.z && StyleParser.cacheDistance(rule_style.z, context)) || StyleParser.defaults.z;

        return style;
    }

});

TextStyle.texture_id = 0;
TextStyle.white = [1, 1, 1, 1];
