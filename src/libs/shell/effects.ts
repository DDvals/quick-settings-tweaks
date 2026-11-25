import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Clutter from 'gi://Clutter'
import Cogl from 'gi://Cogl'
import Global from '../../global.js'

// #region RoundClipEffect
// Shell.GLSLEffect was removed in GNOME Shell 51, where its role is taken over
// by Clutter.ShaderEffect with the get_static_snippet vfunc
// (see https://gitlab.gnome.org/GNOME/gnome-shell and PR #247).
// GJS only hooks vfunc overrides declared in the class body (registering a
// missing vfunc throws), so both variants must be separate registered classes;
// the matching one is chosen at load time.
const useGLSLEffect = (Shell as any).GLSLEffect != null

type CornersCfg = {
	padding?: { left: number, right: number, top: number, bottom: number },
	border_radius: number,
	smoothing: number,
}

// Uniform values shared by both backends (GLSLEffect & ShaderEffect paths)
function computeUniformValues (
	actor: any,
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

	pixel_step ??= [1 / actor.get_width(), 1 / actor.get_height()]

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
		bounds: [...bounds],
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

// Legacy path (GNOME <= 50): Shell.GLSLEffect with GLSL snippet pipeline
const _RoundClipEffectLegacy = useGLSLEffect ? GObject.registerClass(
	class RoundClipEffectLegacy extends (Shell as any).GLSLEffect {
		// Lazily created uniform location cache
		static locations: Record<string, number> | null = null

		vfunc_build_pipeline (): void {
			const [declarations, code] = Global.GetShader("media/rounded_corners.frag")
			this.add_glsl_snippet(
				// FIXME: waitting for type definition update
				Cogl.SnippetHook.FRAGMENT as any,
				declarations,
				code,
				false
			)
		}

		vfunc_paint_target (node: Clutter.PaintNode, ctx: Clutter.PaintContext) {
			// Reset to default blend string.
			this.get_pipeline()?.set_blend(
				'RGBA = ADD(SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))'
			)
			super.vfunc_paint_target(node, ctx)
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
			const values = computeUniformValues((this as any).actor ?? this,
				scale_factor, corners_cfg, outer_bounds, border, pixel_step)
			if (!RoundClipEffectLegacy.locations) {
				const locations: Record<string, number> = {}
				for (const key in uniformDimensions) {
					locations[key] = this.get_uniform_location(key)
				}
				RoundClipEffectLegacy.locations = locations
			}
			for (const key in values) {
				// (location, count, ...values) signature on GLSLEffect
				this.set_uniform_float(RoundClipEffectLegacy.locations[key],
					uniformDimensions[key][1], (values as any)[key])
			}
			this.queue_repaint()
		}
	}
) : null

// New path (GNOME >= 51): Clutter.ShaderEffect with static snippet
const _RoundClipEffectNew = !useGLSLEffect ? GObject.registerClass(
	class RoundClipEffectNew extends Clutter.ShaderEffect {
		vfunc_get_static_snippet (): any {
			const [declarations, code] = Global.GetShader("media/rounded_corners.frag")
			const snippet = new (Cogl as any).Snippet((Cogl as any).SnippetHook.FRAGMENT, declarations, code)
			return snippet
		}

		vfunc_paint_target (node: Clutter.PaintNode, ctx: Clutter.PaintContext) {
			// Reset to default blend string.
			const pipeline = (this as any).get_pipeline()
			if (pipeline) {
				pipeline.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))')
			}
			super.vfunc_paint_target(node, ctx)
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
			const values = computeUniformValues((this as any).actor ?? this,
				scale_factor, corners_cfg, outer_bounds, border, pixel_step)
			for (const key in values) {
				// (name, size, count, values) signature on ShaderEffect
				;(this as any).set_uniform_float(key,
					uniformDimensions[key][0], uniformDimensions[key][1],
					(values as any)[key])
			}
			this.queue_repaint()
		}
	}
) : null

/**
 * Rounded corner clipping effect, compatible with both legacy
 * (Shell.GLSLEffect, GNOME <= 50) and new (Clutter.ShaderEffect, GNOME 51+)
 * shader APIs. Consumers only need: new RoundClipEffect(), .updateUniforms(),
 * and the Clutter.Effect base members.
 */
export type RoundClipEffect = any

// Chosen once at load time; both candidates are already registered above.
const RoundClipEffectClass: any = useGLSLEffect ? _RoundClipEffectLegacy : _RoundClipEffectNew

export function createRoundClipEffect (): any {
	return new RoundClipEffectClass()
}
export function roundClipEffectClass (): any {
	return RoundClipEffectClass
}
// #endregion RoundClipEffect
