/*
 * A category picker that can make a category.
 *
 * Running out of categories in the middle of filing something is the moment you are least
 * willing to go somewhere else and come back. The picker carries a "New category" entry,
 * and choosing it asks for a name, creates it, and selects it without leaving the sheet.
 *
 * The list of options lives inside the bound select, so adding one means rendering the
 * field again rather than reaching into it. That is why this hands back a small object
 * with a value getter instead of the element: after a category is created the original
 * element is gone.
 */

import { Bridge } from '../bridge.js';
import {
  bindSelectFields, promptDialog, selectField, toast,
} from '../ui.js';

export const NEW_CATEGORY = '__new_category__';

/** Category names for a direction, with the entry that makes a new one on the end. */
export function categoryOptions(categories, type = 'Expense') {
  const names = categories
    .filter((category) => !category.type || category.type === type)
    .map((category) => ({ value: category.name, label: category.name }));
  const usable = names.length ? names : categories.map((c) => ({ value: c.name, label: c.name }));
  return [...usable, { value: NEW_CATEGORY, label: 'New category' }];
}

/**
 * Wires a category select so that picking "New category" creates one.
 *
 * `root` is the sheet or container holding the field, `id` the select's id. `type` is
 * read at the moment of creation rather than captured, so a picker sitting next to a
 * direction toggle makes an income category when the row is income.
 */
export function bindCategoryField(root, {
  id, key = 'category', label = 'Category', half = false, categories, type = () => 'Expense',
}) {
  let known = categories.slice();
  let current = root.querySelector(`#${id}`)?.value ?? '';

  const render = (selected) => {
    const field = root.querySelector(`#${id}`).closest('.field');
    field.outerHTML = selectField({
      key,
      label,
      id,
      half,
      value: selected,
      options: categoryOptions(known, typeof type === 'function' ? type() : type),
    });
    wire();
  };

  function wire() {
    const button = root.querySelector(`#${id}`);
    bindSelectFields(button.closest('.field'));

    button.addEventListener('change', async () => {
      if (button.value !== NEW_CATEGORY) {
        current = button.value;
        return;
      }

      const direction = typeof type === 'function' ? type() : type;
      const name = (await promptDialog('New category', {
        body: `It will be available everywhere, filed under ${direction === 'Income' ? 'money in' : 'money out'}.`,
        placeholder: 'Dry cleaning',
      }) || '').trim();

      if (!name) {
        render(current);
        return;
      }

      const res = await Bridge.db('save_category', { category: { name, type: direction } });
      // A name that already exists is not a failure here: the user asked for that
      // category and that category exists, so select it and say nothing.
      if (res.status !== 'success' && res.code !== 'CATEGORY_DUPLICATE') {
        toast(res.message || 'Could not create that category.', 'error');
        render(current);
        return;
      }

      if (!known.some((category) => category.name === name)) {
        known = [...known, { name, type: direction }];
      }
      current = name;
      render(name);
      if (res.status === 'success') toast(`Added "${name}".`, 'success');
    });
  }

  wire();

  return {
    get value() {
      const button = root.querySelector(`#${id}`);
      const picked = button ? button.value : '';
      return picked === NEW_CATEGORY ? '' : picked;
    },
    /** Re-renders for a new direction, keeping the choice if it still makes sense. */
    setType() {
      const direction = typeof type === 'function' ? type() : type;
      const still = known.some((c) => c.name === current && (!c.type || c.type === direction));
      render(still ? current : '');
    },
  };
}
