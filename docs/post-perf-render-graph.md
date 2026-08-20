# Post-stack render-graph decision

Baseline: Three.js r185.1, `Scene MRT -> TRAA -> RenderPipeline`, WebGPU only.

## Why the final output pass remains

The TRAA node has two different obligations:

1. Resolve the current linear scene color against linear history and retain that
   linear result for the next frame.
2. Present the resolved result through the renderer's tone mapping and output
   color-space transform.

Three r185's `RenderPipeline.render()` always executes its private fullscreen
`QuadMesh` against the renderer's current target. With the default target, that
is the browser canvas. The pipeline's default `outputColorTransform` wraps the
output node in `RenderOutputNode`, which applies ACES and the output transfer in
that same final quad.

The default WebGPU canvas target exposes one color attachment. `Renderer.setMRT`
only changes the attachments of a user `RenderTarget`; it cannot add a second
linear-history attachment to the swapchain. Therefore a single TRAA invocation
cannot write both a linear history texture and a tone-mapped swapchain image.
Rendering TRAA into an MRT target would still require a copy/fullscreen
presentation of the transformed attachment, and moving ACES into the existing
TRAA resolve would retain the same fullscreen pass while corrupting the linear
history contract. The final pass is consequently not safely eliminable with the
current Three WebGPU/TSL graph.

## Safe reduction implemented

The two full-resolution TRAA color targets still ping-pong. They are configured
with `depthBuffer: false` and do not depth-test the fullscreen resolve, so their
old per-target `DepthTexture` attachments were only used as alternating copy
destinations. TRAA now owns one standalone `previousDepth` texture, copies the
current scene depth into it once per frame, and samples the same texture on the
next resolve. This removes one full-resolution depth allocation and both unused
target attachments without changing the source depth, copy cadence, depth
encoding, or shader sampling path.

The render-pass count is intentionally unchanged: cloudy views retain
`Scene MRT`, cloud temporal resolve, `TRAA`, and `Final output pass`; clear views
retain the corresponding three passes. The reduction is attachment/memory
bandwidth inside the post stack, not a fake pass fusion.
