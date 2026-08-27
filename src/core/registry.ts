/**
 * 插件注册表
 * 所有插件统一注册到这里，pipeline 按类型取出启用的插件执行
 * 通过 name 唯一标识，可被配置禁用（DISABLE_PLUGINS / DISABLE_SOURCES）
 */

import type { Plugin, PluginType } from './plugin.js';

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();

  /** 注册单个插件（重名抛错，防止意外覆盖） */
  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`插件重名: ${plugin.name}，请检查注册列表`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /** 批量注册 */
  registerAll(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      this.register(plugin);
    }
  }

  /** 按名称获取插件 */
  get<T extends Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }

  /** 获取某类型的所有插件（含被禁用的） */
  byType(type: PluginType): Plugin[] {
    return [...this.plugins.values()].filter(p => p.type === type);
  }

  /** 获取某类型下所有已启用的插件（保持注册顺序，即执行顺序） */
  enabled<T extends Plugin>(type: PluginType, disabled: string[] = []): T[] {
    return this.byType(type).filter(p => !disabled.includes(p.name)) as T[];
  }

  /** 列出所有已注册插件名（调试用） */
  listNames(): string[] {
    return [...this.plugins.keys()];
  }
}

/** 全局注册表单例 */
export const registry = new PluginRegistry();
