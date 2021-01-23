import { LitElement, html, customElement, property, TemplateResult, CSSResult, PropertyValues } from 'lit-element';
import { ChartCardConfig, EntityEntryCache } from './types';
import { HomeAssistant } from 'custom-card-helpers';
import localForage from 'localforage';
import * as pjson from '../package.json';
import { computeName, computeUom, decompress, getMilli, log } from './utils';
import ApexCharts from 'apexcharts';
import { styles } from './styles';
import { HassEntity } from 'home-assistant-js-websocket';
import { getLayoutConfig } from './apex-layouts';
import GraphEntry from './graphEntry';
import { createCheckers } from 'ts-interface-checker';
import { ChartCardExternalConfig } from './types-config';
import exportedTypeSuite from './types-config-ti';

/* eslint no-console: 0 */
console.info(
  `%c APEXCHARTS-CARD %c v${pjson.version} `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

localForage.config({
  name: 'apexchart-card',
  version: 1.0,
  storeName: 'entity_history_cache',
  description: 'ApexCharts-card uses caching for the entity history',
});

localForage
  .iterate((data, key) => {
    const value: EntityEntryCache = key.endsWith('-raw') ? data : decompress(data);
    const start = new Date();
    start.setHours(start.getHours() - value.hours_to_show);
    if (new Date(value.last_fetched) < start) {
      localForage.removeItem(key);
    }
  })
  .catch((err) => {
    console.warn('Purging has errored: ', err);
  });

@customElement('apexcharts-card')
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class ChartsCard extends LitElement {
  private _hass?: HomeAssistant;

  private _apexChart?: ApexCharts;

  private _loaded = false;

  private _updating = false;

  private _graphs: (GraphEntry | undefined)[] | undefined;

  @property() private _config?: ChartCardConfig;

  @property() private _entities: HassEntity[] = [];

  public connectedCallback() {
    super.connectedCallback();
    if (this._config && this._hass && !this._loaded) {
      this._initialLoad();
    }
  }

  protected updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (this._config && this._hass && this.isConnected && !this._loaded) {
      this._initialLoad();
    }
  }

  public set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (!this._config || !this._graphs) return;

    this._graphs.map((graph) => {
      if (graph) graph.hass = hass;
    });

    let updated = false;
    this._config.series.forEach((serie, index) => {
      const entityState = (hass && hass.states[serie.entity]) || undefined;
      if (entityState && this._entities[index] !== entityState) {
        this._entities[index] = entityState;
        updated = true;
      }
    });
    if (updated) {
      this._entities = [...this._entities];
      if (!this._updating) {
        this._updating = true;
        // give time to HA's recorder component to write the data in the history
        setTimeout(() => {
          this._updateData();
        }, 1000);
      }
    }
  }

  public setConfig(config: ChartCardExternalConfig) {
    const { ChartCardExternalConfig } = createCheckers(exportedTypeSuite);
    ChartCardExternalConfig.check(config);

    this._config = {
      hours_to_show: 24,
      cache: true,
      useCompress: false,
      header: { display: true },
      ...JSON.parse(JSON.stringify(config)),
    };

    if (this._config) {
      this._graphs = this._config.series.map((serie, index) => {
        serie.extend_to_end = serie.extend_to_end !== undefined ? serie.extend_to_end : true;
        serie.type = serie.type || 'line';
        if (serie.entity) {
          return new GraphEntry(
            serie.entity,
            index,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._config!.hours_to_show,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._config!.cache,
          );
        }
        return undefined;
      });
    }
  }

  static get styles(): CSSResult {
    return styles;
  }

  protected render(): TemplateResult {
    if (!this._config || !this._hass) return html``;
    if (this._config.series.some((_, index) => this._entities[index] === undefined)) {
      return this.renderWarnings();
    }

    return html`
      <ha-card>
        <div class="wrapper ${this._config.header?.display ? 'with-header' : ''}">
          ${this._config.header?.display ? this._renderHeader() : html``}
          <div id="graph-wrapper">
            <div id="graph"></div>
          </div>
        </div>
      </ha-card>
    `;
  }

  renderWarnings() {
    return html`
      <ha-card class="warning">
        <hui-warning>
          <div style="font-weight: bold;">apexcharts-card</div>
          ${this._config?.series.map((_, index) =>
            !this._entities[index]
              ? html` <div>Entity not available: ${this._config?.series[index].entity}</div> `
              : html``,
          )}
        </hui-warning>
      </ha-card>
    `;
  }

  private _renderHeader(): TemplateResult {
    return html`
      <div class="header">
        <div class="title">
          <span class="state">${this._entities[0].state}</span>
          <span class="uom">${computeUom(0, this._config, this._entities)}</span>
        </div>
        <div class="subtitble">${computeName(0, this._config, this._entities)}</div>
      </div>
    `;
  }

  private async _initialLoad() {
    await this.updateComplete;

    if (!this._apexChart && this.shadowRoot && this._config && this.shadowRoot.querySelector('#graph')) {
      this._loaded = true;
      const graph = this.shadowRoot.querySelector('#graph');
      this._apexChart = new ApexCharts(graph, getLayoutConfig(this._config, this._hass));
      this._apexChart.render();
    }
  }

  private async _updateData() {
    if (!this._config || !this._graphs) return;
    const config = this._config;

    // const end = this.getEndDate();
    const end = new Date();
    const start = new Date(end);
    start.setTime(start.getTime() - getMilli(config.hours_to_show));

    try {
      const promise = this._graphs.map((graph) => graph?._updateHistory(start, end));
      await Promise.all(promise);
      const graphData = {
        series: this._graphs.map((graph) => {
          if (!graph || graph.history.length === 0) return { data: [] };
          const index = graph.index;
          return {
            data:
              this._config?.series[index].extend_to_end && this._config?.series[index].type !== 'bar'
                ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                  [...graph.history, ...[[end.getTime(), graph.history.slice(-1)[0]![1]]]]
                : graph.history,
          };
        }),
        xaxis: {
          min: start.getTime(),
          max: end.getTime(),
        },
      };
      this._apexChart?.updateOptions(graphData, false, false);
    } catch (err) {
      log(err);
    }
    this._updating = false;
  }

  public getCardSize(): number {
    return 3;
  }
}

// Configure the preview in the Lovelace card picker
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards = (window as any).customCards || [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards.push({
  type: 'apexcharts-card',
  name: 'ApexCharts Card',
  preview: false,
  description: 'A graph card based on ApexCharts',
});
