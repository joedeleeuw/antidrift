type PageState = {
  content: {
    state: {
      agents: string[];
    };
  };
};

function pickAgents(pageState: PageState): string[] {
  return pageState.content.state.agents;
}

void pickAgents;
