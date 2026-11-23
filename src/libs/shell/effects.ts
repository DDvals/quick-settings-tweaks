import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Clutter from 'gi://Clutter'
import Cogl from 'gi://Cogl'
import Global from '../../global.js'

// #region RoundClipEffect
// Shell.GLSLEffect was removed in GNOME Shell 51, where its role is taken over
// by Clutter.ShaderEffect with the get_static_snippet vfunc
// (see https://gitlab.gnome.org/GNOME/gnome-shell and PR #247).
// Detect which API this shell provides at load time and patch the matching
// vfunc onto the prototype BEFORE registerClass (GJS validates vfunc
// overrides at registration, and throws if the base class lacks the vfunc).
const useGLSLEffect = (Shell as any).GLSLEffect != null

type CornersCfg = {
	padding?: { left: number, right: number, top: number, bottom: number },
	border_radius: number,
	smoothing: number,
}

const BaseClass: any = useGLSLEffect ? (Shell as any).GLSLEffect : Clutter.ShaderEffect

// Uniform values shared by both backends (GLSLEffect & ShaderEffect paths)
function computeUniformValues (
	this_unknown: any,
	scale_factor: number,
	corners_cfg: CornersCfg,
	outer_bounds: { x1: number, x2: number, y1: number, y2: number },
	border?: {
		width: number
		color: [number, number, number, number]
	},
	pixel_step?: [number, number]
) {
	const border_width = (border?.width ?? 0) * scale_factor
	const border_color = border?.color ?? [0, 0, 0, 0]

	const outer_radius = corners_cfg.border_radius * scale_factor
	const { padding, smoothing } = corners_cfg

	const bounds = [
		outer_bounds.x1 + (padding ? (padding.left * scale_factor) : 0),
		outer_bounds.y1 + (padding ? (padding.top * scale_factor) : 0),
		outer_bounds.x2 - (padding ? (padding.right * scale_factor) : 0),
		outer_bounds.y2 - (padding ? (padding.bottom * scale_factor) : 0),
	]

	const inner_bounds = [
		bounds[0] + border_width,
		bounds[1] + border_width,
		bounds[2] - border_width,
		bounds[3] - border_width,
	]

	let inner_radius = outer_radius - border_width
	if (inner_radius < 0.001) {
		inner_radius = 0.0
	}

	pixel_step ??= [1 / this_unknown.get_width(), 1 / this_unknown.get_height()]

	// Setup with squircle shape
	let exponent = smoothing * 10.0 + 2.0
	let radius = outer_radius * 0.5 * exponent
	const max_radius = Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1])
	if (radius > max_radius) {
		exponent *= max_radius / radius
		radius = max_radius
	}
	inner_radius *= radius / outer_radius

	return {
		bounds: [/* dims=4 */ ...bounds],
		inner_bounds: [...inner_bounds],
		pixel_step: [...pixel_step],
		border_width: [border_width],
		exponent: [exponent],
		clip_radius: [radius],
		border_color: [...border_color],
		inner_clip_radius: [inner_radius],
	}
}

const uniformDimensions: Record<string, [number, number]> = {
	bounds: [4, 4], inner_bounds: [4, 4], pixel_step: [2, 2],
	border_width: [1, 1], exponent: [1, 1], clip_radius: [1, 1],
	border_color: [4, 4], inner_clip_radius: [1, 1],
}

export class RoundClipEffect extends BaseClass {
	// Lazily created uniform location cache (legacy GLSLEffect path only)
	_staticLocations: Record<string, number> | null = null

	getUniformLocation (name: string): number {
		if (!this._staticLocations) {
			const location: Record<string, number> = {}
			for (const key in uniformDimensions) {
				location[key] = this.get_uniform_location(key)
			}
			this._staticLocations = location
		}
		return this._staticLocations[name]
	}

	private setUniform (name: string, values: number[]) {
		const [size, count] = uniformDimensions[name]
		if (useGLSLEffect) {
			this.set_uniform_float(this.getUniformLocation(name), count, values)
		} else {
			(this as any).set_uniform_float(name, size, count, values)
		}
	}

	updateUniforms (
		scale_factor: number,
		corners_cfg: CornersCfg,
		outer_bounds: { x1: number, x2: number, y1: number, y2: number },
		border?: {
			width: number
			color: [number, number, number, number]
		},
		pixel_step?: [number, number]
	) {
		const values = computeUniformValues.call((this as any).actor ?? this,
			scale_factor, corners_cfg, outer_bounds, border, pixel_step)
		for (const key in values) {
			this.setUniform(key, (values as any)[key])
		}
		this.queue_repaint()
	}

	vfunc_paint_target (node: Clutter.PaintNode, ctx: Clutter.PaintContext) {
		// Reset to default blend string.
		const pipeline = (this as any).get_pipeline()
		if (pipeline) {
			pipeline.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))')
		}
		super.vfunc_paint_target(node, ctx)
	}
}

// Inject the version-specific vfunc override before registration.
const roundClipPrototype = RoundClipEffect.prototype as any
if (useGLSLEffect) {
	// legacy path (GNOME <= 50)
	roundClipPrototype.vfunc_build_pipeline = function (
		this: any
	) {
		const [declarations, code] = Global.GetShader("media/rounded_corners.frag")
		this.add_glsl_snippet(
			// FIXME: waitting for type definition update
			(Cogl as any).SnippetHook.FRAGMENT,
			declarations,
			code,
			false
		)
	}
} else {
	// GNOME 51+ path
	roundClipPrototype.vfunc_get_static_snippet = function (): any {
		const [declarations, code] = Global.GetShader("media/rounded_corners.frag")
		const snippet = new (Cogl as any).Snippet((Cogl as any).SnippetHook.FRAGMENT, declarations, code)
		return snippet
	}
}

GObject.registerClass(RoundClipEffect)
// #endregion RoundClipEffect
