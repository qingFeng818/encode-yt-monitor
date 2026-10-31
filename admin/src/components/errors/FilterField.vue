<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { FilterFieldConfig } from './filterConfig';

/**
 * 单个搜索字段（输入框 / 下拉）。
 *
 * 不直接使用 v-model，是因为值类型统一收敛成 string：
 * 这样搜索栏草稿对象、URL query 解析、重置逻辑可以共用同一套结构。
 */
const props = defineProps<{
  field: FilterFieldConfig;
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** 输入框里按回车：交给父组件触发查询 */
  submit: [];
}>();

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}

function onSelect(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <label
    class="filter-field"
    :style="{ width: `${props.field.width ?? 220}px` }"
    :title="props.field.title"
  >
    <span class="field-label">{{ props.field.label }}</span>

    <span v-if="props.field.type === 'search'" class="control">
      <AppIcon :name="props.field.icon ?? 'search'" :size="15" class="control-prefix" />
      <input
        class="control-input"
        type="search"
        autocomplete="off"
        :value="props.modelValue"
        :placeholder="props.field.placeholder"
        @input="onInput"
        @keydown.enter.prevent="emit('submit')"
      />
    </span>

    <span v-else class="control">
      <AppIcon v-if="props.field.icon" :name="props.field.icon" :size="15" class="control-prefix" />
      <select class="control-input control-select" :value="props.modelValue" @change="onSelect">
        <option v-for="option in props.field.options ?? []" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </span>
  </label>
</template>

<style scoped>
.filter-field {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.field-label {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.control:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.control-prefix {
  flex: none;
  color: var(--text-muted);
}

.control-input {
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}

.control-input::placeholder {
  color: var(--text-muted);
}

.control-select {
  padding-right: 2px;
  cursor: pointer;
  appearance: auto;
}

/** 去掉 Chrome 原生搜索框的清除按钮，避免和「重置」按钮语义重叠 */
.control-input::-webkit-search-cancel-button {
  appearance: none;
}
</style>
