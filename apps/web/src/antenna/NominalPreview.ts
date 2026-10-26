import { Box3, Group, Material, Mesh, MeshStandardMaterial, Sphere, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetInfo, Variant } from '../types';
import { createSpacecraftDisplay } from '../graphics/spacecraftDisplay';
import type { AntennaModel } from './types';

export interface NominalGeometryStatus {
  state: 'loading' | 'ready' | 'unavailable';
  revision: string;
  selectedParts: number;
  error?: string;
}

/** Existing concept geometry in nominal body axes. It never supplies an RF field. */
export class NominalPreview {
  readonly group = new Group();
  private readonly basis = new Group();
  private root: Group | null = null;
  private detail: ReturnType<typeof createSpacecraftDisplay> | null = null;
  private abort: AbortController | null = null;
  private key = '';
  private ticket = 0;
  private disposed = false;
  private desiredModel: AntennaModel = 'dipole';
  private selection: Mesh[] = [];
  private readonly origin = new Vector3();
  originReference = 'body origin';
  private selectedMaterials = new Map<
    Mesh,
    { original: Material | Material[]; clones: Material[] }
  >();
  private status: NominalGeometryStatus = {
    state: 'unavailable',
    revision: 'Revision unverified',
    selectedParts: 0,
  };

  constructor(private readonly onStatus: (status: NominalGeometryStatus) => void) {
    // Authored glTF (x,z,-y) becomes the lab's body (x,y,z). No mount articulation.
    this.basis.rotation.x = Math.PI / 2;
    this.group.add(this.basis);
  }

  async load(variant: Variant, asset: AssetInfo | undefined, model: AntennaModel, force = false) {
    const url = asset?.url || `/api/assets/spacecraft.glb?variant=${variant}`;
    const key = `${variant}|${url}|${asset?.sha256 || ''}|${asset?.revision || ''}|${asset?.available ?? ''}`;
    if (this.disposed) return;
    this.desiredModel = model;
    if (key === this.key && !force) {
      this.select(model);
      return;
    }
    this.key = key;
    const ticket = ++this.ticket;
    this.abort?.abort();
    this.abort = new AbortController();
    this.clear();
    const revision = asset?.revision || 'Revision unverified';
    const report = (status: NominalGeometryStatus) => {
      this.status = status;
      this.onStatus(status);
    };
    if (asset?.available === false) {
      report({
        state: 'unavailable',
        revision,
        selectedParts: 0,
        error: 'Physical model unavailable',
      });
      return;
    }
    report({ state: 'loading', revision, selectedParts: 0 });
    try {
      const response = await fetch(url, { signal: this.abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Physical model unavailable (${response.status})`);
      const bytes = await response.arrayBuffer();
      const gltf = await new GLTFLoader().parseAsync(
        bytes,
        new URL(url, window.location.href).href.replace(/[^/]*$/, ''),
      );
      if (this.disposed || ticket !== this.ticket) {
        disposeModel(gltf.scene);
        return;
      }
      this.root = gltf.scene;
      this.basis.add(this.root);
      this.group.scale.setScalar(1);
      this.group.updateMatrixWorld(true);
      const sphere = new Box3().setFromObject(this.basis).getBoundingSphere(new Sphere());
      // One declared, uniform visual scale. Lobe radius is dimensionless, so this
      // juxtaposition cannot be interpreted as RF extent or near-field distance.
      this.group.scale.setScalar(0.55 / Math.max(0.05, sphere.radius + sphere.center.length()));
      this.group.updateMatrixWorld(true);
      this.detail = createSpacecraftDisplay(this.root);
      this.status = {
        state: 'ready',
        revision: response.headers.get('X-Asset-Revision') || revision,
        selectedParts: 0,
      };
      this.select(this.desiredModel);
    } catch (cause) {
      if (
        !this.disposed &&
        ticket === this.ticket &&
        !(cause instanceof DOMException && cause.name === 'AbortError')
      )
        report({
          state: 'unavailable',
          revision,
          selectedParts: 0,
          error: cause instanceof Error ? cause.message : 'Physical model unavailable',
        });
    }
  }

  private restoreSelection() {
    this.selectedMaterials.forEach(({ original, clones }, mesh) => {
      mesh.material = original;
      clones.forEach((material) => material.dispose());
    });
    this.selectedMaterials.clear();
    this.selection = [];
  }

  private select(model: AntennaModel) {
    this.restoreSelection();
    this.root?.traverse((object) => {
      if (!(object instanceof Mesh) || model === 'spherical_harmonic') return;
      const selected =
        model === 'patch'
          ? /^Fixed[_ ]S-band[_ ]patch/.test(object.name)
          : object.name.startsWith('TAPE_CONDUCTOR_');
      if (!selected) return;
      const original = object.material;
      const clones = (Array.isArray(original) ? original : [original]).map((material) => {
        const clone = material.clone();
        if (clone instanceof MeshStandardMaterial) {
          clone.emissive.set('#c72d43');
          clone.emissiveIntensity = 0.45;
        }
        return clone;
      });
      object.material = Array.isArray(original) ? clones : clones[0];
      this.selectedMaterials.set(object, { original, clones });
      this.selection.push(object);
    });
    this.group.updateMatrixWorld(true);
    this.origin.set(0, 0, 0);
    const feed = this.root?.getObjectByName('ANTENNA_FEED_REFERENCE');
    if (model !== 'patch' && model !== 'spherical_harmonic' && feed) {
      feed.getWorldPosition(this.origin);
      this.originReference = 'nominal feed';
    } else if (this.selection.length) {
      const bounds = new Box3();
      this.selection.forEach((mesh) => bounds.union(new Box3().setFromObject(mesh)));
      bounds.getCenter(this.origin);
      this.originReference = 'radiator center';
    } else this.originReference = 'body origin';
    if (this.status.state === 'ready') {
      this.status = { ...this.status, selectedParts: this.selection.length };
      this.onStatus(this.status);
    }
  }

  update(
    camera: Parameters<ReturnType<typeof createSpacecraftDisplay>['update']>[0],
    physicalHeight: number,
  ) {
    this.group.updateMatrixWorld(true);
    this.detail?.update(camera, physicalHeight, 0.55);
  }

  patternOrigin() {
    return this.origin;
  }

  selectionSphere() {
    if (!this.root) return null;
    this.group.updateMatrixWorld(true);
    const box = new Box3();
    for (const mesh of this.selection.length ? this.selection : [this.basis])
      box.union(new Box3().setFromObject(mesh));
    return box.getBoundingSphere(new Sphere());
  }

  private clear() {
    this.restoreSelection();
    if (this.root) {
      this.basis.remove(this.root);
      disposeModel(this.root);
    }
    this.root = null;
    this.detail = null;
    this.origin.set(0, 0, 0);
    this.originReference = 'body origin';
  }

  dispose() {
    this.disposed = true;
    ++this.ticket;
    this.abort?.abort();
    this.clear();
    this.group.clear();
  }
}

function disposeModel(root: Group) {
  const geometries = new Set<Mesh['geometry']>(),
    materials = new Set<Material>(),
    textures = new Set<Texture>();
  root.traverse((object) => {
    if (object instanceof Mesh) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material))
          if (value instanceof Texture) textures.add(value);
      }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => {
    const data = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    texture.dispose();
  });
}
