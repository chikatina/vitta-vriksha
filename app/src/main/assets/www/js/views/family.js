/* Household profiles. */

import { Bridge } from '../bridge.js';
import {
  icon, h, toast, sheet, confirmDialog, emptyState, selectField, bindSelectFields,
} from '../ui.js';

const RELATIONSHIPS = ['Spouse', 'Parent', 'Child', 'Sibling', 'Other'];

const AVATAR_COLORS = ['#0E6B5A', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#06B6D4', '#EF4444'];

export async function renderFamily(container, app) {
  const res = await Bridge.db('get_family_members');
  const members = res.members || [];

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Household profiles</div>
      <p class="caption">
        Manage household members to filter views by profile.
      </p>
    </div>

    ${members.length ? `
      <div class="list">
        ${members.map((m) => `
          <div class="list-row">
            <span class="avatar" style="background:${h(m.avatar_color)}">${h(m.name.charAt(0).toUpperCase())}</span>
            <span class="list-row-main">
              <span class="list-row-title">${h(m.name)}</span>
              <span class="list-row-sub">${h(m.relationship)}${m.is_primary ? ' · primary' : ''}</span>
            </span>
            ${m.is_primary
              ? `<span class="badge">${icon('star', 'icon-sm')}You</span>`
              : `<button class="icon-button" data-remove="${m.id}" aria-label="Remove ${h(m.name)}">${icon('delete')}</button>`}
          </div>`).join('')}
      </div>`
    : `<div class="card">${emptyState('group', 'No profiles yet', 'Add family members to start.')}</div>`}

    <button class="btn btn-tonal btn-block" data-add>${icon('person_add')}Add member</button>`;

  container.querySelector('[data-add]').addEventListener('click', () => addMember(app));

  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const confirmed = await confirmDialog('Remove this profile?',
        'Their records stay in the app without a profile tag.',
        { confirmLabel: 'Remove', danger: true });
      if (!confirmed) return;

      const res2 = await app.db('delete_family_member', { member_id: Number(btn.dataset.remove) });
      if (res2) {
        toast('Profile removed.', 'success');
        app.refresh();
      }
    });
  });
}

async function addMember(app) {
  let color = AVATAR_COLORS[0];

  const saved = await sheet('Add someone', `
    <div class="field">
      <label class="field-label" for="memberName">Name</label>
      <input class="input" id="memberName" data-name type="text" placeholder="Their name" autocomplete="off">
    </div>
    ${selectField({
    key: 'relation',
    label: 'Relationship',
    id: 'memberRelation',
    value: RELATIONSHIPS[0],
    options: RELATIONSHIPS,
  })}
    <div class="field">
      <span class="field-label">Colour</span>
      <div class="swatch-grid" data-colors>
        ${AVATAR_COLORS.map((c, i) => `
          <button type="button" class="swatch" data-color="${c}" style="background:${c}"
                  aria-selected="${i === 0}" aria-label="Colour ${c}">${icon('check', 'icon-sm')}</button>`).join('')}
      </div>
    </div>`, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Add</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelectorAll('[data-color]').forEach((btn) => {
        btn.addEventListener('click', () => {
          color = btn.dataset.color;
          node.querySelectorAll('[data-color]').forEach((b) => {
            b.setAttribute('aria-selected', String(b.dataset.color === color));
          });
        });
      });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const name = node.querySelector('[data-name]').value.trim();
        if (!name) {
          toast('Give them a name.', 'error');
          return;
        }
        const res = await app.db('add_family_member', {
          member: {
            name,
            relationship: node.querySelector('[data-field="relation"]')?.value || RELATIONSHIPS[0],
            avatar_color: color,
          },
        });
        if (res) {
          toast('Profile added.', 'success');
          close(true);
        }
      });
    },
  });

  if (saved) app.refresh();
}
