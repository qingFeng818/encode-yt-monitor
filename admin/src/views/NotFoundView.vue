<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
</script>

<template>
  <div class="not-found">
    <div class="code">404</div>
    <h1>页面不存在</h1>
    <p>当前查看的地址没有对应的前端路由，请从左侧菜单进入数据看板。</p>
    <RouterLink class="btn btn-primary" to="/dashboard">
      <AppIcon name="dashboard" :size="16" />
      返回数据看板
    </RouterLink>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 70vh;
  padding: 40px 20px;
  text-align: center;
}

.code {
  color: var(--primary);
  font-family: var(--font-mono);
  font-size: 64px;
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1;
  background: linear-gradient(120deg, var(--primary), var(--purple));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

h1 {
  font-size: 20px;
  font-weight: 650;
}

p {
  max-width: 420px;
  color: var(--text-muted);
  font-size: 13px;
}

.btn {
  margin-top: 8px;
}
</style>
