/** Local Human Atlas viewer. The accompanying muscle list remains usable without WebGL. */
(() => {
	"use strict";
	const viewers = new Map();
	let threePromise;

	async function mount(section) {
		if (viewers.has(section)) return;
		const stage = section.querySelector(".atlas-stage");
		const status = section.querySelector(".atlas-status");
		const buttons = [...section.querySelectorAll("[data-atlas-view]")];
		if (!stage || !status) return;
		const controller = new AbortController();
		const { signal } = controller;
		let renderer;
		let observer;
		let scene;
		let timeout;
		let disposed = false;
		let failed = false;
		const dispose = () => {
			if (disposed) return;
			disposed = true;
			clearTimeout(timeout);
			controller.abort();
			observer?.disconnect();
			scene?.traverse((node) => node.geometry?.dispose());
			const materials = new Set();
			scene?.traverse((node) => {
				if (node.material) materials.add(node.material);
			});
			for (const material of materials) material.dispose();
			renderer?.dispose();
			renderer?.domElement.remove();
			viewers.delete(section);
		};
		viewers.set(section, dispose);
		const fail = () => {
			failed = true;
			for (const button of buttons) button.disabled = true;
			section.dataset.atlasState = "error";
			status.hidden = false;
			status.textContent = "3D表示を読み込めませんでした。鍛えた部位は下の一覧で確認できます。";
		};
		timeout = setTimeout(() => {
			if (disposed) return;
			fail();
			dispose();
		}, 30_000);
		try {
			threePromise ??= import("/js/vendor/three.module.js");
			const THREE = await threePromise;
			if (disposed) return;
			renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
			const response = await fetch("/models/human-atlas/atlas.json", { signal });
			if (!response.ok) throw new Error("Atlas model could not be loaded");
			const model = await response.json();
			const chunks = await Promise.all(model.chunks.map(async (chunk) => {
				const result = await fetch(chunk.url, { signal });
				if (!result.ok) throw new Error("Atlas geometry could not be loaded");
				let buffer = await result.arrayBuffer();
				const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2));
				if (header[0] === 0x1f && header[1] === 0x8b) {
					buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
				}
				return buffer;
			}));
			if (disposed) return;
			const patterns = JSON.parse(section.dataset.muscles || "[]").map((name) => name.toLowerCase());
			scene = new THREE.Scene();
			const body = new THREE.Group();
			scene.add(body);
			const neutral = new THREE.MeshStandardMaterial({ color: 0x738399, roughness: 0.72, metalness: 0.08 });
			const active = new THREE.MeshStandardMaterial({ color: 0x38dfcb, emissive: 0x0d8c79, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.12 });
			const skin = new THREE.MeshStandardMaterial({ color: 0xa8bfce, transparent: true, opacity: 0.08, depthWrite: false, roughness: 1 });
			let selectedCount = 0;
			for (const item of model.parts) {
				const buffer = chunks[item.chunk];
				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buffer, item.positions, item.vertexCount * 3), 3));
				geometry.setAttribute("normal", new THREE.BufferAttribute(new Int16Array(buffer, item.normals, item.vertexCount * 3), 3, true));
				geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, item.indices, item.indexCount), 1));
				const isSkin = item.system === "integumentary";
				const selected = !isSkin && patterns.some((pattern) => item.name.toLowerCase().includes(pattern));
				if (selected) selectedCount++;
				const mesh = new THREE.Mesh(geometry, isSkin ? skin : selected ? active : neutral);
				body.add(mesh);
			}
			if (!body.children.length) throw new Error("Atlas model is empty");
			const bounds = new THREE.Box3().setFromObject(body);
			const center = bounds.getCenter(new THREE.Vector3());
			body.position.sub(center);
			const pivot = new THREE.Group();
			scene.add(pivot);
			pivot.add(body);
			const size = bounds.getSize(new THREE.Vector3());
			const halfHeight = size.y * 0.55;
			const camera = new THREE.OrthographicCamera(-halfHeight, halfHeight, halfHeight, -halfHeight, 0.01, size.y * 12);
			camera.position.set(0, 0, size.y * 3);
			camera.lookAt(0, 0, 0);
			scene.add(new THREE.HemisphereLight(0xe4f7ff, 0x182634, 2.8));
			const key = new THREE.DirectionalLight(0xffffff, 3);
			key.position.set(-size.y, size.y, size.y * 2);
			scene.add(key);
			const rim = new THREE.DirectionalLight(0x5ae0d2, 2);
			rim.position.set(size.y, 0, -size.y);
			scene.add(rim);
			renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			renderer.setClearColor(0x000000, 0);
			renderer.outputColorSpace = THREE.SRGBColorSpace;
			const canvas = renderer.domElement;
			canvas.setAttribute("role", "img");
			canvas.setAttribute("aria-label", "鍛えた筋肉を青緑で示す人体図。左右矢印キーまたは横ドラッグで回転できます。");
			canvas.tabIndex = 0;
			canvas.style.touchAction = "pan-y";
			canvas.style.display = "block";
			canvas.style.width = "100%";
			canvas.style.height = "100%";
			stage.append(canvas);
			canvas.addEventListener("webglcontextlost", (event) => {
				event.preventDefault();
				fail();
			}, { signal });
			const render = () => {
				if (disposed || failed) return;
				try { renderer.render(scene, camera); } catch { fail(); }
			};
			const syncButtons = () => {
				const angle = ((pivot.rotation.y % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
				for (const button of buttons) {
					const target = button.dataset.atlasView === "back" ? Math.PI : 0;
					const distance = Math.min(Math.abs(angle - target), Math.PI * 2 - Math.abs(angle - target));
					button.setAttribute("aria-pressed", String(distance < 0.01));
				}
			};
			for (const button of buttons) {
				button.disabled = false;
				button.addEventListener("click", () => {
					pivot.rotation.y = button.dataset.atlasView === "back" ? Math.PI : 0;
					syncButtons();
					render();
				}, { signal });
			}
			canvas.addEventListener("keydown", (event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				pivot.rotation.y += (event.key === "ArrowLeft" ? -1 : 1) * Math.PI / 12;
				syncButtons();
				render();
			}, { signal });
			let drag;
			canvas.addEventListener("pointerdown", (event) => {
				if (!event.isPrimary || event.button !== 0) return;
				drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rotation: pivot.rotation.y, horizontal: false };
			}, { signal });
			canvas.addEventListener("pointermove", (event) => {
				if (!drag || drag.id !== event.pointerId) return;
				const dx = event.clientX - drag.x;
				const dy = event.clientY - drag.y;
				if (!drag.horizontal) {
					if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) { drag = undefined; return; }
					if (Math.abs(dx) < 6) return;
					drag.horizontal = true;
					canvas.setPointerCapture(event.pointerId);
				}
				pivot.rotation.y = drag.rotation + dx * 0.012;
				syncButtons();
				render();
			}, { signal });
			const stopDrag = () => { drag = undefined; };
			canvas.addEventListener("pointerup", stopDrag, { signal });
			canvas.addEventListener("pointercancel", stopDrag, { signal });
			canvas.addEventListener("lostpointercapture", stopDrag, { signal });
			const resize = () => {
				if (disposed) return;
				const width = stage.clientWidth;
				const height = stage.clientHeight;
				if (!width || !height) return;
				const aspect = width / height;
				const extent = Math.max(halfHeight, size.x * 0.58 / aspect);
				camera.left = -extent * aspect;
				camera.right = extent * aspect;
				camera.top = extent;
				camera.bottom = -extent;
				camera.updateProjectionMatrix();
				renderer.setSize(width, height, false);
				render();
			};
			observer = new ResizeObserver(resize);
			observer.observe(stage);
			syncButtons();
			section.dataset.atlasState = "ready";
			status.textContent = selectedCount ? "青緑は鍛えた部位 · 左右キーやドラッグで回転" : "記録した種目に合わせて筋肉をハイライトします";
			status.hidden = true;
			clearTimeout(timeout);
			resize();
		} catch (error) {
			if (!disposed && error.name !== "AbortError") {
				fail();
				dispose();
			}
		}
	}
	function init() {
		for (const [section, dispose] of viewers) if (!section.isConnected) dispose();
		for (const section of document.querySelectorAll(".muscle-atlas")) mount(section);
	}
	document.addEventListener("htmx:load", init);
	document.addEventListener("htmx:beforeCleanupElement", (event) => {
		for (const [section, dispose] of viewers) if (event.detail.elt.contains(section)) dispose();
	});
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
	else init();
})();
